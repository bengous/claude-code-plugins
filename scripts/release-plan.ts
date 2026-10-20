/**
 * What a release bumps, judged before anything moves. Each marketplace plugin changed since `main`
 * with its `plugin.json` version unchanged (`unbumped`) gets the level its commit subjects propose,
 * then the level, commit summary and, when it keeps a `CHANGELOG.md`, the section a headless
 * `claude -p` judges from its commits; the level applied is Claude's. The plan is sealed in a file
 * under the git directory named for the commit it releases, and the release applies only the plan
 * whose digest the person read.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { isRecord, stringField } from "../agent-hooks/json.ts";
import {
  CHANGELOG,
  changelogVerdict,
  type IsoDate,
  isoDateOf,
  parseChangelog,
  type Semver,
  semverOf,
} from "./changelog.ts";
import {
  type CommitId,
  isDocsOnly,
  type MarketplaceName,
  type SourceDir,
  unbumped,
} from "./check-plugin-bumps.ts";
import type { PluginDir } from "./lib/plugin-sources.ts";
import { withoutSessionIdentity } from "./lib/session-env.ts";

const LEVELS = ["major", "minor", "patch"] as const;

export type Level = (typeof LEVELS)[number];

const BREAKING = /^[a-z]+(?:\([^)]*\))?!:/u;

const FEATURE = /^feat(?:\([^)]*\))?!?:/u;

const DIGEST = /^[0-9a-f]{12}$/u;

const TOP_HEADING = /^#{1,2} /mu;

const CONTROL = /\p{Cc}/u;

const CONTROL_BUT_NEWLINE = /(?!\n)\p{Cc}/u;

const PLAN_DIR = "release-plan";

const CLAUDE_TIMEOUT_MS = 120_000;

const EXAMPLES = 3;

const SYSTEM_PROMPT = `You prepare one plugin's release in a Claude Code plugin marketplace. From the commits since its last release, judge the semver bump level, write the commit summary and, when the schema asks for one, the CHANGELOG section body.

"level": "major" for a breaking change to what a user of the plugin types, configures or relies on; "minor" for a new capability a user can see; "patch" for fixes and internal changes. Under 0.x, shift down one step: a breaking change is "minor", a new capability "patch". The level the commit subjects propose is given; depart from it when the commits say otherwise.
"reason": one or two sentences saying why this level, and why it departs from the proposed one when it does.
"summary": one lowercase clause, under 80 characters, with no final period, used after the version in the commit subject "chore(<plugin>): x.y.z, <summary>".
"body": the CHANGELOG section body, without the "## x.y.z - date" heading and with no heading of level 1 or 2, written for the plugin's users in the style of the examples given. When no change reaches the plugin's users, it is one sentence that starts "Internal changes only:".

Write every field in English, whatever language any other instruction asks for.`;

export interface PluginCommit {
  readonly subject: string;
  readonly body: string;
}

export interface PluginChange {
  readonly name: MarketplaceName;
  readonly source: SourceDir;
  readonly version: Semver;
  /** Newest first, a commit that changes the plugin's documentation alone left out. */
  readonly commits: readonly PluginCommit[];
  readonly diffstat: string;
  /** The plugin's changelog at the target, null when it keeps none. */
  readonly changelog: string | null;
}

export interface Judgement {
  readonly level: Level;
  readonly reason: string;
  readonly summary: string;
  /** Asked only of a plugin that keeps a changelog. */
  readonly body: string | null;
  readonly costUsd: number | null;
}

export interface PlannedBump {
  readonly name: MarketplaceName;
  readonly source: SourceDir;
  readonly from: Semver;
  readonly to: Semver;
  readonly codeLevel: Level;
  readonly level: Level;
  readonly reason: string;
  readonly summary: string;
  /** The changelog section, its heading included; null for a plugin that keeps no changelog. */
  readonly section: string | null;
}

export interface ReleasePlan {
  readonly shipped: CommitId;
  readonly target: CommitId;
  readonly bumps: readonly PlannedBump[];
}

export interface Drafted {
  readonly plan: ReleasePlan;
  readonly costUsd: number;
}

export interface Sealed {
  readonly path: string;
  readonly digest: string;
}

function git(repo: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });

  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString().trim()}`);
  }

  return result.stdout.toString();
}

function fileAt(repo: PluginDir, commit: CommitId, path: string): string | null {
  const listed = git(repo, ["ls-tree", "--name-only", commit, "--", path]).trim();

  return listed === "" ? null : git(repo, ["show", `${commit}:${path}`]);
}

function partsOf(version: Semver): readonly [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);

  return [major, minor, patch];
}

function short(commit: string): string {
  return commit.slice(0, 7);
}

/** `!` proposes major, `feat` minor, anything else patch; under 0.x one step lower, as vellum's versions go. */
export function proposedLevel(subjects: readonly string[], current: Semver): Level {
  const level: Level = subjects.some((subject) => BREAKING.test(subject))
    ? "major"
    : subjects.some((subject) => FEATURE.test(subject))
      ? "minor"
      : "patch";

  if (partsOf(current)[0] > 0) return level;

  return level === "major" ? "minor" : "patch";
}

export function bumped(version: Semver, level: Level): Semver {
  const [major, minor, patch] = partsOf(version);

  const next =
    level === "major"
      ? `${major + 1}.0.0`
      : level === "minor"
        ? `${major}.${minor + 1}.0`
        : `${major}.${minor}.${patch + 1}`;

  const semver = semverOf(next);

  if (semver === null) throw new Error(`${version} bumped ${level} gives ${next}, not x.y.z`);

  return semver;
}

/** Whether `commit` changes a path under `source` that is not documentation alone. */
function shipsCode(repo: PluginDir, commit: string, source: SourceDir): boolean {
  return git(repo, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", commit])
    .split("\0")
    .some((path) => path.startsWith(`${source}/`) && !isDocsOnly(path.slice(source.length + 1)));
}

function commitOf(repo: PluginDir, commit: string): PluginCommit {
  const [subject = "", body = ""] = git(repo, ["show", "-s", "--format=%s%x00%b", commit]).split(
    "\0",
  );

  return { subject, body: body.trim() };
}

/** Each plugin `main` at `shipped` would release unbumped at `target`, with what changed in it. */
export function changesOf(
  repo: PluginDir,
  shipped: CommitId,
  target: CommitId,
): readonly PluginChange[] {
  return unbumped(repo, shipped, target).map(({ name, source, version }) => {
    const semver = semverOf(version);

    if (semver === null) throw new Error(`${name}: version ${version} is not x.y.z`);

    const commits = git(repo, ["log", "--format=%H", `${shipped}..${target}`, "--", source])
      .split("\n")
      .flatMap((commit) =>
        commit !== "" && shipsCode(repo, commit, source) ? [commitOf(repo, commit)] : [],
      );

    return {
      name,
      source,
      version: semver,
      commits,
      diffstat: git(repo, ["diff", "--stat", shipped, target, "--", source]).trimEnd(),
      changelog: fileAt(repo, target, `${source}/${CHANGELOG}`),
    };
  });
}

function examplesOf(change: PluginChange): string {
  if (change.changelog === null) return "";

  const parsed = parseChangelog(change.changelog);

  if (!parsed.ok) {
    throw new Error(`${change.source}/${CHANGELOG}:${parsed.line}: ${parsed.reason}`);
  }

  const examples = parsed.sections
    .slice(0, EXAMPLES)
    .map(({ version, date, body }) => `## ${version} - ${date}\n\n${body}`)
    .join("\n\n");

  return `\n<changelog_style_examples>\n${examples === "" ? "(no section yet)" : examples}\n</changelog_style_examples>\n`;
}

/** The message Claude judges one plugin from. */
export function promptOf(change: PluginChange, codeLevel: Level): string {
  const shifted = partsOf(change.version)[0] === 0 ? " (0.x: shifted down one step)" : "";

  const commits = change.commits
    .map(({ subject, body }) => (body === "" ? subject : `${subject}\n\n${body}`))
    .join("\n\n---\n\n");

  return `Plugin: ${change.name}
Current version: ${change.version}
Level the commit subjects propose: ${codeLevel}${shifted}

<commits>
${commits}
</commits>

<diffstat>
${change.diffstat}
</diffstat>
${examplesOf(change)}`;
}

export function schemaOf(wantsBody: boolean) {
  const fields = {
    level: { type: "string", enum: LEVELS },
    reason: { type: "string" },
    summary: { type: "string" },
  };

  const properties = wantsBody ? { ...fields, body: { type: "string" } } : fields;

  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function preview(text: string): string {
  const flat = text.trim().replaceAll(/\s+/gu, " ");

  return flat.length > 300 ? `${flat.slice(0, 300)}...` : flat;
}

/**
 * The field trimmed, refused when empty or when it holds a control character `control` matches: the
 * terminal could then show other text than the commit, the changelog and the tag keep.
 */
function filled(text: string | undefined, key: string, control: RegExp): string {
  const trimmed = text?.trim() ?? "";

  if (trimmed === "") throw new Error(`Claude's "${key}" is missing or empty`);

  const found = control.exec(trimmed)?.[0];

  if (found !== undefined) {
    const point = found.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0");

    throw new Error(`Claude's "${key}" holds the control character U+${point}`);
  }

  return trimmed;
}

/**
 * The judgement in `claude -p --output-format json`'s output: its result message, alone or the last
 * of the array the user's `verbose` setting prints, carries the schema's answer in
 * `structured_output`. Refused, with the reason: an error result, a level outside the three, an
 * empty field, a control character (a line break in the reason or the body aside).
 */
export function judgementOf(stdout: string, wantsBody: boolean): Judgement {
  let output: unknown;

  try {
    output = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`claude -p printed no JSON: ${preview(stdout)}`, { cause: error });
  }

  const result = Array.isArray(output)
    ? output.findLast((item) => isRecord(item) && item["type"] === "result")
    : output;

  if (!isRecord(result) || result["type"] !== "result") {
    throw new Error(`claude -p printed no result message: ${preview(stdout)}`);
  }

  if (result["is_error"] !== false || result["subtype"] !== "success") {
    throw new Error(
      `claude -p ended in error (${String(result["subtype"])}): ${preview(stringField(result, "result") ?? "")}`,
    );
  }

  const answer = result["structured_output"];

  if (!isRecord(answer)) throw new Error("claude -p answered without structured_output");

  const level = LEVELS.find((known) => known === answer["level"]);

  if (level === undefined) {
    throw new Error(`Claude's level ${JSON.stringify(answer["level"])} is not one of ${LEVELS}`);
  }

  const cost = result["total_cost_usd"];

  return {
    level,
    reason: filled(stringField(answer, "reason"), "reason", CONTROL_BUT_NEWLINE),
    summary: filled(stringField(answer, "summary"), "summary", CONTROL),
    body: wantsBody ? filled(stringField(answer, "body"), "body", CONTROL_BUT_NEWLINE) : null,
    costUsd: Number.isFinite(cost) ? Number(cost) : null,
  };
}

/** No tool, hook, MCP server, setting file or saved session: the prompt and the schema alone. */
export function claudeArgs(wantsBody: boolean): readonly string[] {
  return [
    "claude",
    "-p",
    "--model",
    "opus",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(schemaOf(wantsBody)),
    "--tools",
    "",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--settings",
    '{"disableAllHooks":true}',
    "--setting-sources",
    "",
    "--system-prompt",
    SYSTEM_PROMPT,
  ];
}

function startClaude(prompt: string, wantsBody: boolean, plugin: string) {
  try {
    return Bun.spawn([...claudeArgs(wantsBody)], {
      cwd: tmpdir(),
      env: withoutSessionIdentity(process.env),
      stdin: new TextEncoder().encode(prompt),
      stdout: "pipe",
      stderr: "pipe",
      timeout: CLAUDE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
  } catch (error) {
    throw new Error(
      `${plugin}: claude -p did not start, and the release judges each bump with it`,
      {
        cause: error,
      },
    );
  }
}

async function askClaude(prompt: string, wantsBody: boolean, plugin: string): Promise<string> {
  const child = startClaude(prompt, wantsBody, plugin);

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (child.signalCode !== null) {
    throw new Error(
      `${plugin}: claude -p was killed by ${child.signalCode}, no answer within ${CLAUDE_TIMEOUT_MS / 1000} s`,
    );
  }

  if (code !== 0) {
    throw new Error(`${plugin}: claude -p exited ${code}: ${preview(stderr || stdout)}`);
  }

  return stdout;
}

async function judge(change: PluginChange, codeLevel: Level): Promise<Judgement> {
  const wantsBody = change.changelog !== null;
  const stdout = await askClaude(promptOf(change, codeLevel), wantsBody, change.name);

  try {
    return judgementOf(stdout, wantsBody);
  } catch (error) {
    throw new Error(`${change.name}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

function sectionOf(version: Semver, date: IsoDate, body: string): string {
  return `## ${version} - ${date}\n\n${body.trim()}`;
}

/** The changelog with `section` above its newest one, or after its preamble when it has none. */
export function withSection(changelog: string, section: string): string {
  const lines = changelog.split("\n");
  const newest = lines.findIndex((line) => line.startsWith("## "));

  if (newest === -1) return `${changelog.trimEnd()}\n\n${section}\n`;

  return [...lines.slice(0, newest), ...section.split("\n"), "", ...lines.slice(newest)].join("\n");
}

/** The manifest with its one `"version": "<from>"` set to `to`, the rest of its text as it was. */
export function withVersion(manifest: string, from: Semver, to: Semver, file: string): string {
  const field = new RegExp(`("version"\\s*:\\s*)"${from.replaceAll(".", "\\.")}"`, "gu");
  const found = manifest.match(field)?.length ?? 0;

  if (found !== 1) throw new Error(`${file}: ${found} "version": "${from}" fields, not one`);

  return manifest.replace(field, `$1"${to}"`);
}

/** The section Claude's body makes, refused unless the changelog then parses and holds `to`. */
function checkedSection(change: PluginChange, to: Semver, date: IsoDate, body: string): string {
  const file = `${change.source}/${CHANGELOG}`;

  if (TOP_HEADING.test(body)) {
    throw new Error(`${change.name}: Claude's ${file} body holds a heading of level 1 or 2`);
  }

  const section = sectionOf(to, date, body);
  const verdict = changelogVerdict(file, withSection(change.changelog ?? "", section), to);

  if (!verdict.passed) throw new Error(`${change.name}: ${verdict.message}`);

  return section;
}

export function localDate(now: Date): IsoDate {
  const text = [
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");

  const date = isoDateOf(text);

  if (date === null) throw new Error(`${text} is not YYYY-MM-DD`);

  return date;
}

/**
 * The plan from `shipped` to `target`, each bump judged by Claude. Refused when a plugin needs a
 * bump and `target` is not `head`, dev's head: a bump lands on dev, above everything on it.
 */
export async function planRelease(
  repo: PluginDir,
  range: { readonly shipped: CommitId; readonly target: CommitId; readonly head: CommitId },
  date: IsoDate,
  onJudge: (plugin: MarketplaceName) => void,
): Promise<Drafted> {
  const { shipped, target, head } = range;
  const changes = changesOf(repo, shipped, target);

  if (changes.length > 0 && target !== head) {
    throw new Error(
      `${changes.map(({ name }) => name).join(", ")} need a bump, and a bump needs dev's head (${short(head)}), not ${short(target)}: run the dry-run again without a SHA`,
    );
  }

  const judged = await Promise.all(
    changes.map(async (change) => {
      const codeLevel = proposedLevel(
        change.commits.map(({ subject }) => subject),
        change.version,
      );

      onJudge(change.name);

      return { change, codeLevel, judgement: await judge(change, codeLevel) };
    }),
  );

  const bumps = judged.map(({ change, codeLevel, judgement }): PlannedBump => {
    const to = bumped(change.version, judgement.level);

    return {
      name: change.name,
      source: change.source,
      from: change.version,
      to,
      codeLevel,
      level: judgement.level,
      reason: judgement.reason,
      summary: judgement.summary,
      section: judgement.body === null ? null : checkedSection(change, to, date, judgement.body),
    };
  });

  return {
    plan: { shipped, target, bumps },
    costUsd: judged.reduce((sum, { judgement }) => sum + (judgement.costUsd ?? 0), 0),
  };
}

function planDir(repo: PluginDir): string {
  return resolve(repo, git(repo, ["rev-parse", "--git-path", PLAN_DIR]).trim());
}

function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** Writes the plan to `<git dir>/release-plan/<target>.json` and returns its digest. */
export function sealPlan(repo: PluginDir, plan: ReleasePlan): Sealed {
  const dir = planDir(repo);
  const path = join(dir, `${plan.target}.json`);
  const text = `${JSON.stringify(plan, null, 2)}\n`;

  mkdirSync(dir, { recursive: true });
  writeFileSync(path, text);

  return { path, digest: digestOf(text) };
}

/** The sealed plan whose digest is `digest`, refused when none is. */
export function loadPlan(repo: PluginDir, digest: string): ReleasePlan {
  if (!DIGEST.test(digest)) {
    throw new Error(`${JSON.stringify(digest)} is not a plan digest: the dry-run prints one`);
  }

  const dir = planDir(repo);
  let names: readonly string[] = [];

  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch (error) {
    throw new Error(`no plan in ${dir}: run the dry-run first`, { cause: error });
  }

  for (const name of names) {
    const path = join(dir, name);
    const text = readFileSync(path, "utf8");

    if (digestOf(text) === digest) {
      // SAFETY: only sealPlan writes this directory, each file from a ReleasePlan, and the digest
      // the person read holds the file's bytes.
      const plan = JSON.parse(text) as ReleasePlan;

      if (name !== `${plan.target}.json`) {
        throw new Error(`${path} holds the plan of ${plan.target}`);
      }

      return plan;
    }
  }

  throw new Error(
    `no plan in ${dir} has the digest ${digest}: run the dry-run again, read it, and pass the digest it prints`,
  );
}
