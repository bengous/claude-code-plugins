#!/usr/bin/env bun

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters -- this script IS the boundary parser those rules ask for: it is installed alone in another repository, and narrows here what `gh`, `claude -p` and its own JSON files hold, refusing a record of another shape. */

/**
 * The tier of a pull request's head commit: `low` lands once its checks are green, `human` waits for the owner.
 *
 *   bun .github/factory/tier.ts gate --repo <owner/name> --pr <n> --head <sha> [--ask]
 *   bun .github/factory/tier.ts replay --repo <owner/name> [--record]
 *
 * `gate` is what the owner gate runs, from a checkout of the base branch: the rules beside this file and
 * `CODEOWNERS` are the base branch's, and the change is read through GitHub's API, never checked out. The floor
 * decides first. Past it, Claude Haiku reads the diff alone, headless, with no tool, hook, settings file or MCP
 * server, and only with the model and the prompt `tier-cases.json` was validated with. Its verdict is recorded as a
 * `tier` check run on the head commit, which a later run reuses in place of asking again. Without `--ask`, a change
 * that needs the classifier answers `ask`, and a pull request that moved past `--head` answers `superseded`: the
 * run of its new head judges it. Any failure answers `human`, with its reason.
 *
 * `replay` judges each case of `tier-cases.json` three times and reports agreement and every false `low`. With
 * `--record`, a run with no false `low` and no failure writes the model and the prompt it validated into the file.
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

export type Tier = "low" | "human";

export interface Verdict {
  readonly tier: Tier;
  readonly reason: string;
}

/** One file of the change; `previous` is the path a rename moved it from. */
export interface FileChange {
  readonly path: string;
  readonly previous: string | null;
  readonly lines: number;
}

export interface Unreadable {
  readonly kind: "unreadable";
  readonly why: string;
}

export type Read<T> = { readonly kind: "read"; readonly value: T } | Unreadable;

export interface Config {
  readonly lineCap: number;
  readonly humanPaths: readonly string[];
}

export interface Case {
  readonly name: string;
  readonly expected: Tier;
  /** A pull request of the repository, read as the gate reads one. */
  readonly pr?: number;
  /** Or a unified diff, which only the classifier reads. */
  readonly diff?: string;
}

/** The model and the prompt digest the cases were validated with, null until a replay recorded them. */
export interface Calibration {
  readonly model: string | null;
  readonly prompt: string | null;
  readonly cases: readonly Case[];
}

export interface Rules {
  readonly owners: Read<readonly string[]>;
  readonly config: Read<Config>;
  readonly system: string;
  readonly calibration: Read<Calibration>;
}

/** A verdict of the classifier as its check run holds it, with the digests of the prompt and of the diff it judged. */
export interface Recorded {
  readonly tier: Tier;
  readonly reason: string;
  readonly prompt: string;
  readonly model: string;
  readonly diff: string;
}

export interface GitHub {
  readonly head: (pr: number) => Promise<string>;
  readonly files: (pr: number) => Promise<readonly FileChange[]>;
  readonly diff: (pr: number) => Promise<string>;
  /** The verdicts GitHub Actions recorded on the commit, oldest first. */
  readonly records: (sha: string) => Promise<readonly Recorded[]>;
  readonly record: (sha: string, recorded: Recorded) => Promise<void>;
}

/** Asks `model` the tier of the change in `prompt`, under `system`; answers `claude -p --output-format json`'s stdout. */
export type Ask = (model: string, system: string, prompt: string) => Promise<string>;

export type By = "floor" | "calibration" | "record" | "judge" | "failure";

export type Decision =
  | { readonly kind: "decided"; readonly verdict: Verdict; readonly by: By }
  | { readonly kind: "ask" }
  /** The pull request moved to another head: this run judges nothing, and the run of that head shows its tier. */
  | { readonly kind: "superseded"; readonly head: string };

/** A decision and the lines the change adds and removes, null when the change was not read. */
export interface Outcome {
  readonly decision: Decision;
  readonly lines: number | null;
}

export interface Answer {
  readonly tier: Tier;
  readonly reason: string;
  /** The model that answered, as `claude -p` names it; null when its output does not say. */
  readonly model: string | null;
}

const TIERS: readonly Tier[] = ["low", "human"];

export const RECORD_NAME = "tier";

const ACTIONS_APP = "github-actions";

const UNVALIDATED_MODEL = "haiku";

const CLAUDE_TIMEOUT_MS = 120_000;

const GH_TIMEOUT_MS = 60_000;

const RUNS_PER_CASE = 3;

const CONCURRENCY = 4;

const REASON_MAX = 300;

const DIFF_MAX = 400_000;

const SHOWN = 3;

const CONTROL = /\p{Cc}/gu;

const GLOB_CHARS = /[*?[]/u;

const SCHEMA = {
  type: "object",
  properties: {
    tier: { type: "string", enum: TIERS },
    reason: { type: "string" },
  },
  required: ["tier", "reason"],
  additionalProperties: false,
};

/** What a Claude Code session hands its children: a `claude` started from one would take itself for a nested session. */
const NOT_FOR_THE_CLASSIFIER: ReadonlySet<string> = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
  "CLAUDE_PROJECT_DIR",
  "GH_TOKEN",
  "GITHUB_TOKEN",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];

  return typeof value === "string" ? value : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function oneLine(text: string): string {
  return text.replaceAll(CONTROL, " ").replaceAll(/\s+/gu, " ").trim().slice(0, REASON_MAX);
}

function unreadable(why: string): Unreadable {
  return { kind: "unreadable", why };
}

function human(reason: string, by: By): Decision {
  return { kind: "decided", verdict: { tier: "human", reason }, by };
}

function named(paths: readonly string[]): string {
  const shown = paths.slice(0, SHOWN).join(", ");

  return paths.length > SHOWN ? `${shown} and ${paths.length - SHOWN} more` : shown;
}

export function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/**
 * The path prefixes `CODEOWNERS` lists, each read from the root as the owner gate always read them. A pattern that
 * is not such a prefix does not read, which makes every path sensitive.
 */
export function parseOwners(text: string): Read<readonly string[]> {
  const prefixes = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.split(/\s+/u)[0] ?? "");

  if (prefixes.length === 0) return unreadable("CODEOWNERS lists no path");

  const unread = prefixes.find((prefix) => !prefix.startsWith("/") || GLOB_CHARS.test(prefix));

  return unread === undefined
    ? { kind: "read", value: prefixes }
    : unreadable(`CODEOWNERS holds ${unread}, which is not a path prefix from the root`);
}

/** `tier.json` read strictly: an unknown key or a malformed value does not read, so a typo never loosens the floor. */
export function parseConfig(text: string): Read<Config> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return unreadable(`tier.json is not JSON: ${messageOf(error)}`);
  }

  if (!isRecord(parsed)) return unreadable("tier.json is not an object");

  const unknown = Object.keys(parsed).find((key) => key !== "lineCap" && key !== "humanPaths");

  if (unknown !== undefined) return unreadable(`tier.json has an unknown key "${unknown}"`);

  const { lineCap, humanPaths } = parsed;

  if (typeof lineCap !== "number" || !Number.isInteger(lineCap) || lineCap < 1) {
    return unreadable("tier.json: lineCap is a whole number of lines, 1 or more");
  }

  if (
    !Array.isArray(humanPaths) ||
    !humanPaths.every((glob): glob is string => typeof glob === "string" && glob.trim() !== "")
  ) {
    return unreadable("tier.json: humanPaths is a list of globs");
  }

  const anchored = humanPaths.find((glob) => glob.startsWith("/") || glob.startsWith("./"));

  return anchored === undefined
    ? { kind: "read", value: { lineCap, humanPaths } }
    : unreadable(`tier.json: "${anchored}" is anchored; a glob is relative to the repository root`);
}

/** Why the change waits for the owner whatever the classifier would say, or null when the floor lets it through. */
export function floorOf(
  files: readonly FileChange[],
  owners: Read<readonly string[]>,
  config: Read<Config>,
): Verdict | null {
  if (files.length === 0) return { tier: "human", reason: "the change touches no file" };

  if (owners.kind === "unreadable") {
    return { tier: "human", reason: `every path is sensitive: ${owners.why}` };
  }

  if (config.kind === "unreadable") {
    return { tier: "human", reason: `the floor does not read: ${config.why}` };
  }

  const paths = [
    ...new Set(
      files.flatMap(({ path, previous }) => (previous === null ? [path] : [previous, path])),
    ),
  ];

  const reasons: string[] = [];

  const sensitive = paths.filter((path) =>
    owners.value.some((prefix) => `/${path}`.startsWith(prefix)),
  );

  if (sensitive.length > 0) reasons.push(`touches a sensitive path: ${named(sensitive)}`);

  const globs = config.value.humanPaths.map((glob) => new Bun.Glob(glob));
  const sent = paths.filter((path) => globs.some((glob) => glob.match(path)));

  if (sent.length > 0) reasons.push(`touches a path tier.json sends to the owner: ${named(sent)}`);

  const lines = linesOf(files);

  if (lines > config.value.lineCap) {
    reasons.push(`${lines} lines changed, past the ${config.value.lineCap}-line cap`);
  }

  return reasons.length === 0 ? null : { tier: "human", reason: reasons.join("; ") };
}

export function linesOf(files: readonly FileChange[]): number {
  return files.reduce((sum, file) => sum + file.lines, 0);
}

export function parseCalibration(text: string): Read<Calibration> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return unreadable(`tier-cases.json is not JSON: ${messageOf(error)}`);
  }

  if (!isRecord(parsed) || !Array.isArray(parsed["cases"])) {
    return unreadable("tier-cases.json holds no cases array");
  }

  const entries: unknown[] = parsed["cases"];
  const cases: Case[] = [];

  for (const [index, value] of entries.entries()) {
    const where = `tier-cases.json: case ${index + 1}`;

    if (!isRecord(value)) return unreadable(`${where} is not an object`);

    const name = stringField(value, "name");
    const expected = TIERS.find((tier) => tier === value["expected"]);

    if (name === undefined || expected === undefined) {
      return unreadable(`${where} needs a name and an expected tier, low or human`);
    }

    const { pr } = value;
    const diff = stringField(value, "diff");

    if (typeof pr === "number" && Number.isInteger(pr) && pr > 0 && diff === undefined) {
      cases.push({ name, expected, pr });
    } else if (pr === undefined && diff !== undefined && diff.trim() !== "") {
      cases.push({ name, expected, diff });
    } else {
      return unreadable(`${where} (${name}) needs a pr number or a diff, not both`);
    }
  }

  return {
    kind: "read",
    value: {
      model: stringField(parsed, "model") ?? null,
      prompt: stringField(parsed, "prompt") ?? null,
      cases,
    },
  };
}

/** Why the classifier may not answer: no cases validated yet, or a prompt other than the one they validated. */
export function staleness(calibration: Read<Calibration>, system: string): string | null {
  if (calibration.kind === "unreadable") return calibration.why;

  const { model, prompt } = calibration.value;

  if (model === null || prompt === null) {
    return "the floor runs alone: tier-cases.json names no model and prompt it was validated with";
  }

  const now = digestOf(system);

  return prompt === now
    ? null
    : `the floor runs alone: tier-prompt.md is ${now}, tier-cases.json was validated with ${prompt}`;
}

export function promptOf(diff: string): string {
  return `<diff>\n${diff}\n</diff>`;
}

/**
 * The answer in `claude -p --output-format json`'s output: its result message, alone or the last of the array a
 * `verbose` setting prints, carries the schema's answer in `structured_output` and the model in `modelUsage`.
 */
export function answerOf(stdout: string): Answer {
  let output: unknown;

  try {
    output = JSON.parse(stdout);
  } catch {
    throw new Error(`claude -p printed no JSON: ${stdout.trim().slice(0, 200)}`);
  }

  const result: unknown = Array.isArray(output)
    ? output.findLast((item) => isRecord(item) && item["type"] === "result")
    : output;

  if (!isRecord(result) || result["type"] !== "result") {
    throw new Error("claude -p printed no result message");
  }

  if (result["is_error"] !== false || result["subtype"] !== "success") {
    throw new Error(
      `claude -p ended in error (${String(result["subtype"])}): ${(stringField(result, "result") ?? "").slice(0, 200)}`,
    );
  }

  const answer = result["structured_output"];

  if (!isRecord(answer)) throw new Error("claude -p answered without structured_output");

  const tier = TIERS.find((known) => known === answer["tier"]);

  if (tier === undefined) {
    throw new Error(`the classifier's tier ${JSON.stringify(answer["tier"])} is not low or human`);
  }

  const reason = oneLine(stringField(answer, "reason") ?? "");

  if (reason === "") throw new Error("the classifier gave no reason");

  const usage = result["modelUsage"];
  const models = isRecord(usage) ? Object.keys(usage) : [];

  return { tier, reason, model: models.length === 1 ? (models[0] ?? null) : null };
}

/** No tool, hook, MCP server, settings file or saved session: the system prompt, the schema and the diff alone. */
export function claudeArgs(model: string, system: string): readonly string[] {
  return [
    "claude",
    "-p",
    "--model",
    model,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(SCHEMA),
    "--tools",
    "",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--settings",
    '{"disableAllHooks":true}',
    "--setting-sources",
    "",
    "--system-prompt",
    system,
  ];
}

interface Exited {
  readonly stdout: string;
  readonly stderr: string;
  /** Null when the process was killed at its timeout. */
  readonly code: number | null;
}

async function outputOf(
  argv: readonly string[],
  cwd: string,
  stdin: string | null,
  timeout: number,
): Promise<Exited> {
  const child = Bun.spawn([...argv], {
    cwd,
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => argv[0] !== "claude" || !NOT_FOR_THE_CLASSIFIER.has(name),
      ),
    ),
    stdin: stdin === null ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    timeout,
    killSignal: "SIGKILL",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { stdout, stderr, code: child.signalCode === null ? code : null };
}

export const askClaude: Ask = async (model, system, prompt) => {
  // A private empty directory: a CLAUDE.md planted in the shared tmpdir would be read.
  const cwd = mkdtempSync(join(tmpdir(), "tier-"));

  try {
    const { stdout, stderr, code } = await outputOf(
      claudeArgs(model, system),
      cwd,
      prompt,
      CLAUDE_TIMEOUT_MS,
    );

    if (code === null) {
      throw new Error(`claude -p gave no answer within ${CLAUDE_TIMEOUT_MS / 1000} s`);
    }

    if (code !== 0) throw new Error(`claude -p exited ${code}: ${(stderr || stdout).trim()}`);

    return stdout;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
};

const withoutSecret: Ask = () =>
  Promise.reject(new Error("the secret CLAUDE_CODE_OAUTH_TOKEN is not set"));

async function gh(args: readonly string[], stdin: string | null = null): Promise<string> {
  const { stdout, stderr, code } = await outputOf(
    ["gh", ...args],
    process.cwd(),
    stdin,
    GH_TIMEOUT_MS,
  );

  if (code === null) throw new Error(`gh ${args.slice(0, 2).join(" ")} gave no answer in time`);

  if (code !== 0) {
    throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${oneLine(stderr || stdout)}`);
  }

  return stdout;
}

/** The files of `GET /pulls/{n}/files`, every page in one array of pages. */
export function filesOf(pages: unknown): readonly FileChange[] {
  if (!Array.isArray(pages)) throw new Error("the pull request's files did not read");

  return pages.flat().map((file: unknown): FileChange => {
    if (!isRecord(file)) throw new Error("the pull request's files did not read");

    const path = stringField(file, "filename");
    const { additions, deletions } = file;

    if (path === undefined || typeof additions !== "number" || typeof deletions !== "number") {
      throw new Error("a file of the pull request has no name or no line counts");
    }

    return {
      path,
      previous: stringField(file, "previous_filename") ?? null,
      lines: additions + deletions,
    };
  });
}

/**
 * What a recorded check run holds in `external_id`, space-separated: the tier, the prompt's digest, the model and
 * the digest of the diff. One commit has another diff against another base, so the commit alone names no verdict.
 */
export function externalIdOf({ tier, prompt, model, diff }: Recorded): string {
  return `${tier} ${prompt} ${model} ${diff}`;
}

/**
 * The verdicts in `GET /commits/{sha}/check-runs`, oldest first. Only a completed `tier` run that GitHub Actions
 * created counts: no other app, and no other record, is trusted.
 */
export function recordsOf(listing: unknown): readonly Recorded[] {
  if (!isRecord(listing) || !Array.isArray(listing["check_runs"])) {
    throw new Error("the commit's check runs did not read");
  }

  const runs: unknown[] = listing["check_runs"];

  return runs
    .flatMap((run): { readonly id: number; readonly recorded: Recorded }[] => {
      if (!isRecord(run) || run["name"] !== RECORD_NAME || run["status"] !== "completed") return [];

      const { app, id, output } = run;

      if (!isRecord(app) || app["slug"] !== ACTIONS_APP || typeof id !== "number") return [];

      const [tierText = "", prompt = "", model = "", diff = "", ...rest] = (
        stringField(run, "external_id") ?? ""
      ).split(" ");

      const tier = TIERS.find((known) => known === tierText);

      if (tier === undefined || prompt === "" || model === "" || diff === "" || rest.length > 0) {
        return [];
      }

      const summary = oneLine(isRecord(output) ? (stringField(output, "summary") ?? "") : "");
      const reason = summary === "" ? "recorded" : summary;

      return [{ id, recorded: { tier, reason, prompt, model, diff } }];
    })
    .toSorted((a, b) => a.id - b.id)
    .map(({ recorded }) => recorded);
}

export function githubOf(repo: string): GitHub {
  return {
    head: async (pr) =>
      (await gh(["api", `repos/${repo}/pulls/${pr}`, "--jq", ".head.sha"])).trim(),
    files: async (pr) =>
      filesOf(
        JSON.parse(
          await gh([
            "api",
            `repos/${repo}/pulls/${pr}/files?per_page=100`,
            "--paginate",
            "--slurp",
          ]),
        ),
      ),
    diff: (pr) =>
      gh(["api", `repos/${repo}/pulls/${pr}`, "-H", "Accept: application/vnd.github.diff"]),
    records: async (sha) =>
      recordsOf(
        JSON.parse(
          await gh([
            "api",
            `repos/${repo}/commits/${sha}/check-runs?check_name=${RECORD_NAME}&filter=all&per_page=100`,
          ]),
        ),
      ),
    record: async (sha, recorded) => {
      await gh(
        ["api", "-X", "POST", `repos/${repo}/check-runs`, "--input", "-", "--silent"],
        JSON.stringify({
          name: RECORD_NAME,
          head_sha: sha,
          status: "completed",
          conclusion: "neutral",
          external_id: externalIdOf(recorded),
          output: { title: `tier: ${recorded.tier}`, summary: recorded.reason },
        }),
      );
    },
  };
}

/** The classifier's verdict on a diff, asked of `model`; a classifier that fails answers `human` with why. */
async function judge(
  diff: string,
  system: string,
  model: string,
  ask: Ask,
): Promise<{ readonly decision: Decision; readonly model: string | null }> {
  if (diff.length > DIFF_MAX) {
    return {
      decision: human(
        `the diff is ${diff.length} characters, past the ${DIFF_MAX} the classifier reads`,
        "failure",
      ),
      model: null,
    };
  }

  try {
    const answer = answerOf(await ask(model, system, promptOf(diff)));

    return {
      decision: {
        kind: "decided",
        verdict: { tier: answer.tier, reason: answer.reason },
        by: "judge",
      },
      model: answer.model,
    };
  } catch (error) {
    return { decision: human(oneLine(messageOf(error)), "failure"), model: null };
  }
}

/**
 * The tier of the pull request at `head`: the floor, else the verdict recorded on that commit for this diff, else
 * the validated classifier, asked through `ask` and recorded. With no `ask`, a change that needs the classifier
 * answers `ask`.
 */
export async function decide(
  github: GitHub,
  rules: Rules,
  ask: Ask | null,
  pr: number,
  head: string,
): Promise<Outcome> {
  const current = await github.head(pr);

  if (current !== head) return { decision: { kind: "superseded", head: current }, lines: null };

  const files = await github.files(pr);
  const lines = linesOf(files);
  const floor = floorOf(files, rules.owners, rules.config);

  if (floor !== null) return { decision: { kind: "decided", verdict: floor, by: "floor" }, lines };

  const stale = staleness(rules.calibration, rules.system);

  if (stale !== null || rules.calibration.kind === "unreadable") {
    return { decision: human(stale ?? "tier-cases.json does not read", "calibration"), lines };
  }

  const model = rules.calibration.value.model ?? "";
  const prompt = digestOf(rules.system);
  const change = await github.diff(pr);
  const diff = digestOf(change);

  const recorded = (records: readonly Recorded[]): Recorded | undefined =>
    records.find(
      (record) => record.prompt === prompt && record.model === model && record.diff === diff,
    );

  const earlier = recorded(await github.records(head));

  if (earlier !== undefined) {
    return {
      decision: {
        kind: "decided",
        verdict: { tier: earlier.tier, reason: earlier.reason },
        by: "record",
      },
      lines,
    };
  }

  if (ask === null) return { decision: { kind: "ask" }, lines };

  const judged = await judge(change, rules.system, model, ask);

  if (judged.decision.kind !== "decided" || judged.decision.by !== "judge") {
    return { decision: judged.decision, lines };
  }

  if (judged.model !== model) {
    return {
      decision: human(
        `${judged.model ?? "an unnamed model"} answered, tier-cases.json was validated with ${model}`,
        "calibration",
      ),
      lines,
    };
  }

  await github.record(head, { ...judged.decision.verdict, prompt, model, diff });

  // Two runs of the gate on one commit can both ask: the oldest record is the verdict of both.
  const first = recorded(await github.records(head));

  return {
    decision:
      first === undefined
        ? judged.decision
        : { kind: "decided", verdict: { tier: first.tier, reason: first.reason }, by: "judge" },
    lines,
  };
}

const DECIDED_BY: Readonly<Record<By, string>> = {
  floor: "the floor",
  calibration: "the floor alone: the classifier is not validated for this repository",
  record: "the check run recorded on this commit: the classifier was not asked again",
  judge: "the classifier",
  failure: "a failure, which answers human",
};

export function summaryOf(
  verdict: Verdict,
  by: By,
  head: string,
  lines: number | null,
  config: Read<Config>,
): string {
  const size =
    lines === null
      ? ""
      : `, ${lines} lines changed${config.kind === "read" ? `, the cap is ${config.value.lineCap}` : ""}`;

  return [
    `### Tier: ${verdict.tier}`,
    "",
    verdict.reason,
    "",
    `Decided by ${DECIDED_BY[by]}. Commit \`${head.slice(0, 7)}\`${size}. The rules are the base branch's.`,
    "",
  ].join("\n");
}

export function readRules(dir: string): Rules {
  const text = (path: string): string => readFileSync(join(dir, path), "utf8");

  const read = <T>(path: string, parse: (content: string) => Read<T>): Read<T> => {
    try {
      return parse(text(path));
    } catch (error) {
      return unreadable(`${path} does not read: ${messageOf(error)}`);
    }
  };

  return {
    owners: read("../CODEOWNERS", parseOwners),
    config: read("tier.json", parseConfig),
    system: text("tier-prompt.md"),
    calibration: read("tier-cases.json", parseCalibration),
  };
}

function report(name: string, lines: readonly string[]): void {
  const file = process.env[name];

  if (file !== undefined && file !== "") appendFileSync(file, `${lines.join("\n")}\n`);
}

async function gate(repo: string, pr: number, head: string, asks: boolean): Promise<number> {
  let config: Read<Config> = unreadable("not read");
  let outcome: Outcome;

  try {
    const rules = readRules(import.meta.dir);
    const hasSecret = (process.env["CLAUDE_CODE_OAUTH_TOKEN"] ?? "") !== "";

    ({ config } = rules);
    outcome = await decide(
      githubOf(repo),
      rules,
      asks ? (hasSecret ? askClaude : withoutSecret) : null,
      pr,
      head,
    );
  } catch (error) {
    outcome = { decision: human(oneLine(messageOf(error)), "failure"), lines: null };
  }

  const { decision, lines } = outcome;

  if (decision.kind === "ask") {
    console.log("ask the change passed the floor and no verdict is recorded on this commit");
    report("GITHUB_OUTPUT", ["ask=true"]);

    return 0;
  }

  if (decision.kind === "superseded") {
    console.log(`superseded the pull request moved to ${decision.head.slice(0, 7)}`);
    report("GITHUB_OUTPUT", ["superseded=true"]);

    return 0;
  }

  const { verdict, by } = decision;

  console.log(`${verdict.tier} ${verdict.reason}`);
  report("GITHUB_OUTPUT", [
    `tier=${verdict.tier}`,
    `by=${by}`,
    `reason=${oneLine(verdict.reason)}`,
  ]);
  report("GITHUB_STEP_SUMMARY", [summaryOf(verdict, by, head, lines, config)]);

  return 0;
}

async function pooled<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  // One iterator shared by the workers: each takes the next item when it is free.
  const queue = items.entries();

  const worker = async (): Promise<void> => {
    for (const [index, item] of queue) {
      // oxlint-disable-next-line no-await-in-loop -- each worker takes one item at a time, CONCURRENCY workers at once.
      results[index] = await work(item);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));

  return results;
}

export interface CaseRuns {
  readonly entry: Case;
  readonly runs: readonly Decision[];
  readonly models: readonly string[];
}

/** Each case judged as the gate would judge it, the classifier asked three times: its noise is what a replay samples. */
export function replayCases(
  github: GitHub,
  rules: Rules,
  calibration: Calibration,
  ask: Ask,
): Promise<readonly CaseRuns[]> {
  const model = calibration.model ?? UNVALIDATED_MODEL;

  return pooled(calibration.cases, async (entry): Promise<CaseRuns> => {
    if (entry.pr !== undefined) {
      const floor = floorOf(await github.files(entry.pr), rules.owners, rules.config);

      if (floor !== null) {
        return { entry, runs: [{ kind: "decided", verdict: floor, by: "floor" }], models: [] };
      }
    }

    const diff = entry.diff ?? (await github.diff(entry.pr ?? 0));
    const runs: Decision[] = [];
    const models: string[] = [];

    for (let attempt = 0; attempt < RUNS_PER_CASE; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- the runs of one case go one after the other, CONCURRENCY cases at once.
      const judged = await judge(diff, rules.system, model, ask);

      runs.push(judged.decision);

      if (judged.model !== null) models.push(judged.model);
    }

    return { entry, runs, models };
  });
}

export interface ReplayReport {
  readonly lines: readonly string[];
  /** The one model that answered every judged run, when the run has no false `low` and no failure. */
  readonly trusted: string | null;
}

function listed(title: string, items: readonly string[]): string {
  return `${title} ${items.length}${items.map((item) => `\n  ${item}`).join("")}`;
}

export function reportOf(
  results: readonly CaseRuns[],
  asked: string,
  prompt: string,
): ReplayReport {
  const lines: string[] = [];
  const failures: string[] = [];
  const falseLows: string[] = [];
  const falseHumans: string[] = [];
  const models = new Set<string>();
  let agreed = 0;
  let total = 0;
  let judged = 0;

  for (const { entry, runs, models: answered } of results) {
    const verdicts = runs.flatMap((run) => (run.kind === "decided" ? [run] : []));

    for (const model of answered) models.add(model);

    for (const { verdict, by } of verdicts) {
      total += 1;

      if (by === "judge") judged += 1;

      if (by === "failure") failures.push(`${entry.name}: ${verdict.reason}`);
      else if (verdict.tier === entry.expected) agreed += 1;
      else if (verdict.tier === "low") falseLows.push(`${entry.name}: ${verdict.reason}`);
      else falseHumans.push(`${entry.name}: ${verdict.reason}`);
    }

    lines.push(
      [
        entry.name,
        `expected ${entry.expected}`,
        verdicts.map(({ verdict }) => verdict.tier).join(","),
        verdicts[0]?.by ?? "",
        verdicts.at(-1)?.verdict.reason ?? "",
      ].join("\t"),
    );
  }

  const lowsLost = results.flatMap(({ entry, runs }) =>
    entry.expected === "low" &&
    runs.length > 0 &&
    runs.every(
      (run) => run.kind === "decided" && run.by !== "failure" && run.verdict.tier === "human",
    )
      ? [entry.name]
      : [],
  );

  lines.push(
    "",
    `agreement ${agreed}/${total} runs; ${judged} judged by the classifier, ${failures.length} failed, the rest by the floor`,
    listed("failed", failures),
    listed("false low", falseLows),
    listed("false human", falseHumans),
    listed("low read human on every run", lowsLost),
    `model ${[...models].join(", ") || "none answered"}, asked as ${asked}; prompt ${prompt}`,
  );

  const [only] = [...models];

  const trusted =
    falseLows.length === 0 && failures.length === 0 && judged > 0 && models.size === 1
      ? (only ?? null)
      : null;

  return { lines, trusted };
}

async function replay(repo: string, record: boolean): Promise<number> {
  const rules = readRules(import.meta.dir);

  if (rules.calibration.kind === "unreadable") {
    console.error(`tier: ${rules.calibration.why}`);

    return 2;
  }

  const calibration = rules.calibration.value;
  const prompt = digestOf(rules.system);

  const { lines, trusted } = reportOf(
    await replayCases(githubOf(repo), rules, calibration, askClaude),
    calibration.model ?? UNVALIDATED_MODEL,
    prompt,
  );

  console.log(lines.join("\n"));

  if (trusted === null) {
    console.log(
      "not validated: the classifier is trusted only after a run with no false low and no failure, judged by one model",
    );

    return 1;
  }

  if (record) {
    const file = join(import.meta.dir, "tier-cases.json");
    const stored: unknown = JSON.parse(readFileSync(file, "utf8"));

    if (!isRecord(stored)) throw new Error("tier-cases.json is not an object");

    // oxlint-disable-next-line local/no-raw-write -- installed alone in another repository, with no platform helper beside it; the file is tracked, so git restores a write cut short.
    writeFileSync(file, `${JSON.stringify({ ...stored, model: trusted, prompt }, null, 2)}\n`);
    console.log(`recorded in tier-cases.json: model ${trusted}, prompt ${prompt}`);
  } else {
    console.log(
      `validated: --record writes model ${trusted} and prompt ${prompt} into tier-cases.json`,
    );
  }

  return 0;
}

const USAGE = `Usage: tier.ts gate --repo <owner/name> --pr <n> --head <sha> [--ask]
       tier.ts replay --repo <owner/name> [--record]`;

function main(argv: readonly string[]): Promise<number> {
  let parsed;

  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        repo: { type: "string" },
        pr: { type: "string" },
        head: { type: "string" },
        ask: { type: "boolean", default: false },
        record: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    console.error(`tier: ${messageOf(error)}\n\n${USAGE}`);

    return Promise.resolve(2);
  }

  const { values, positionals } = parsed;
  const [mode, ...extra] = positionals;
  const { repo, head } = values;
  const pr = Number(values.pr);

  if (extra.length === 0 && repo !== undefined && /^[\w.-]+\/[\w.-]+$/u.test(repo)) {
    if (mode === "gate" && !values.record && Number.isInteger(pr) && pr > 0 && head !== undefined) {
      return gate(repo, pr, head, values.ask);
    }

    if (mode === "replay" && !values.ask && values.pr === undefined && head === undefined) {
      return replay(repo, values.record);
    }
  }

  console.error(USAGE);

  return Promise.resolve(2);
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`tier: ${messageOf(error)}`);
    process.exitCode = 2;
  }
}
