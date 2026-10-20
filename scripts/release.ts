#!/usr/bin/env bun

/**
 * The release step, run by the human: bump each plugin changed since `main`, wait for CI on dev,
 * push `main`, then tag each plugin that keeps a `CHANGELOG.md` and shipped a new version, on the
 * commit that set it, and publish its GitHub Release.
 *
 *   bun ./scripts/release.ts --dry-run [--json] [<ref>]   # judge the bumps, print and seal the plan
 *   bun ./scripts/release.ts --plan <digest>              # apply the sealed plan whose digest was read
 *
 * The dry-run judges each bump with Claude (`release-plan.ts`) and writes nothing but the plan,
 * sealed under the git directory; `--json` prints it as one JSON document, for an agent, in place
 * of the text a person reads. `<ref>` (default: origin/dev) may be an older SHA only when
 * nothing needs a bump. The run applies that plan as it was read: one `chore(<plugin>): x.y.z,
 * <summary>` commit per bump, with its changelog section, made in a temporary worktree where the
 * commit hooks run, pushed to dev, rebased when dev moved by commits the plan does not need to
 * cover and that make no tag the plan did not print; then it waits for that commit's push run of
 * CI to end green, prints each commit dev moved by past the plan's target, and moves `main` there.
 * Everything is read and checked before a push: a changelog that does not parse, or a tag that
 * already exists, stops the release with `main` unmoved. The notes are the changelog's sections
 * newer than the version `main` held, written into the annotated tag, and the Release reads them
 * back from it. Never: a tag before the push landed, a tag moved.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { styleText } from "node:util";

import {
  CHANGELOG,
  notesSince,
  parseChangelog,
  type Semver,
  semverOf,
  versionCommits,
} from "./changelog.ts";
import {
  catalogAt,
  type CommitId,
  commitAt,
  type MarketplaceName,
  unbumped,
  versionAt,
} from "./check-plugin-bumps.ts";
import { type CiOutcome, type Gh, ghCli, type WaitLimits, waitFor } from "./ci-wait.ts";
import { type PluginDir, pluginDirAt } from "./lib/plugin-sources.ts";
import {
  type JudgeEvent,
  JUDGE_MODEL,
  type Level,
  localDate,
  loadPlan,
  type PlannedBump,
  planRelease,
  type ReleasePlan,
  type Sealed,
  sealPlan,
  withSection,
  withVersion,
} from "./release-plan.ts";

const REMOTE = "origin";

const MAIN = `${REMOTE}/main`;

const DEV = "dev";

const DEFAULT_REF = `${REMOTE}/${DEV}`;

const MANIFEST = ".claude-plugin/plugin.json";

const ATTEMPTS = 3;

const CI_LIMITS: WaitLimits = { timeoutMs: 30 * 60_000, pollMs: 15_000 };

const USAGE = [
  "Usage: bun ./scripts/release.ts --dry-run [--json] [<ref>]   # judge the bumps, print and seal the plan",
  "       bun ./scripts/release.ts --plan <digest>              # apply the sealed plan",
].join("\n");

const MAX_WIDTH = 100;

const LABEL_WIDTH = 8;

/** An annotated tag's name, `<marketplace name>-v<x.y.z>`. */
export type TagName = string & { readonly __brand: "TagName" };

export interface PlannedTag {
  readonly name: MarketplaceName;
  readonly version: Semver;
  readonly tag: TagName;
  /** The commit that set `version`: the tag goes there, not on the release head. */
  readonly commit: CommitId;
  /** The changelog's sections newer than the version `main` held. */
  readonly notes: string;
}

export type ReleaseOutcome =
  | { readonly kind: "released"; readonly tags: readonly PlannedTag[] }
  | { readonly kind: "push-refused"; readonly why: string }
  | {
      readonly kind: "tag-failed";
      readonly tag: TagName;
      readonly step: string;
      readonly why: string;
    };

/**
 * What applying a plan ends on: refused with nothing moved, stopped on CI, stopped with the bumps on
 * dev and main unmoved, or the release's own outcome.
 */
export type ShipOutcome =
  | { readonly kind: "refused"; readonly why: string }
  | {
      readonly kind: "ci-not-green";
      readonly head: CommitId;
      readonly bumped: boolean;
      readonly ci: Exclude<CiOutcome, { readonly kind: "green" }>;
    }
  | { readonly kind: "after-bumps"; readonly head: CommitId; readonly why: string }
  | ReleaseOutcome;

/** What the command line asks: `--dry-run` anywhere among the arguments, as the landing guard reads it. */
export type Cli =
  | { readonly kind: "dry-run"; readonly ref: string | null; readonly json: boolean }
  | { readonly kind: "apply"; readonly digest: string }
  | { readonly kind: "usage" };

export interface Context {
  readonly gh: Gh;
  readonly limits: WaitLimits;
  readonly say: (line: string) => void;
}

/** The commit `main` moves to once its push run is green, with the tags planned on it; or why there is none. */
type Bumped =
  | { readonly kind: "ready"; readonly head: CommitId; readonly tags: readonly PlannedTag[] }
  | { readonly kind: "refused"; readonly why: string };

/** One command of a tag's publication, named for the message that reports its failure. */
interface Step {
  readonly step: string;
  readonly cmd: readonly string[];
  readonly stdin?: string;
}

interface Run {
  readonly ok: boolean;
  readonly out: string;
  readonly err: string;
}

function run(cmd: readonly string[], cwd: string, stdin?: string): Run {
  const result = Bun.spawnSync([...cmd], {
    cwd,
    env: process.env,
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    ok: result.exitCode === 0,
    out: result.stdout.toString(),
    err: result.stderr.toString().trim(),
  };
}

function git(cwd: string, args: readonly string[]): string {
  const result = run(["git", ...args], cwd);

  if (!result.ok) throw new Error(`git ${args.join(" ")}: ${result.err}`);

  return result.out;
}

function short(commit: string): string {
  return commit.slice(0, 7);
}

export function tagNameOf(name: MarketplaceName, version: Semver): TagName {
  // SAFETY: the brand states `<name>-v<x.y.z>`, built from a checked name and version.
  return `${name}-v${version}` as TagName;
}

function fileAt(repo: PluginDir, commit: CommitId, path: string): string | null {
  const result = run(["git", "cat-file", "-p", `${commit}:${path}`], repo);

  return result.ok ? result.out : null;
}

function tagExists(repo: PluginDir, tag: TagName): boolean {
  return run(["git", "rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], repo).ok;
}

/**
 * The tags a release from `shipped` to `target` makes: one per plugin that
 * keeps a changelog and whose version moved. Reads only; refuses, before any
 * push, a changelog that does not parse, a version it lacks, or a tag that exists.
 */
export function plannedTags(
  repo: PluginDir,
  shipped: CommitId,
  target: CommitId,
): readonly PlannedTag[] {
  const before = new Map(catalogAt(repo, shipped).map(({ name, source }) => [name, source]));

  return catalogAt(repo, target).flatMap(({ name, source }) => {
    const file = `${source}/${CHANGELOG}`;
    const text = fileAt(repo, target, file);

    if (text === null) return [];

    const read = versionAt(repo, target, source);
    const version = semverOf(read);

    if (version === null) throw new Error(`${name}: version ${read} is not x.y.z`);

    const sourceBefore = before.get(name);
    const previous = sourceBefore === undefined ? null : versionAt(repo, shipped, sourceBefore);

    if (previous === version) return [];

    const parsed = parseChangelog(text);

    if (!parsed.ok) throw new Error(`${file}:${parsed.line}: ${parsed.reason}`);

    const set = versionCommits(repo, source, target).find((found) => found.version === version);

    if (set === undefined) throw new Error(`${name}: no commit sets ${version} in its history`);

    const tag = tagNameOf(name, version);

    if (tagExists(repo, tag)) throw new Error(`${tag} exists already: a tag is never moved`);

    const notes = notesSince(parsed.sections, previous === null ? null : semverOf(previous));

    if (notes === "") throw new Error(`${file} has no section newer than ${previous}`);

    return [{ name, version, tag, commit: set.commit, notes }];
  });
}

/** Push `target` to main, then tag and publish each planned tag, stopping at the first failure. */
export function release(
  repo: PluginDir,
  target: CommitId,
  tags: readonly PlannedTag[],
): ReleaseOutcome {
  const pushed = run(["git", "push", REMOTE, `${target}:refs/heads/main`], repo);

  if (!pushed.ok) return { kind: "push-refused", why: pushed.err };

  for (const planned of tags) {
    const steps: readonly Step[] = [
      {
        step: "tag",
        // verbatim: the default `strip` cleanup drops every line starting with `#`, the headings included.
        cmd: ["git", "tag", "-a", "--cleanup=verbatim", "-F", "-", planned.tag, planned.commit],
        stdin: `${planned.notes}\n`,
      },
      { step: "push the tag", cmd: ["git", "push", REMOTE, `refs/tags/${planned.tag}`] },
      {
        step: "publish the Release",
        cmd: [
          "gh",
          "release",
          "create",
          planned.tag,
          "--verify-tag",
          "--title",
          `${planned.name} ${planned.version}`,
          "--notes-from-tag",
        ],
      },
    ];

    for (const { step, cmd, stdin } of steps) {
      const result = run(cmd, repo, stdin);

      if (!result.ok) return { kind: "tag-failed", tag: planned.tag, step, why: result.err };
    }
  }

  return { kind: "released", tags };
}

export function parseCli(args: readonly string[]): Cli {
  if (args.includes("--dry-run")) {
    const [ref, ...extra] = args.filter((arg) => arg !== "--dry-run" && arg !== "--json");

    return extra.length > 0 || ref?.startsWith("-") === true
      ? { kind: "usage" }
      : { kind: "dry-run", ref: ref ?? null, json: args.includes("--json") };
  }

  const [option, digest, ...extra] = args;

  return option === "--plan" && digest !== undefined && extra.length === 0
    ? { kind: "apply", digest }
    : { kind: "usage" };
}

export function subjectOf(bump: PlannedBump): string {
  return `chore(${bump.name}): ${bump.to}, ${bump.summary}`;
}

/** Why the bump's commit failed, its hooks' output included; null once it is made. */
function commitBump(tree: PluginDir, bump: PlannedBump): string | null {
  const manifest = `${bump.source}/${MANIFEST}`;
  const files = [manifest];

  writeFileSync(
    join(tree, manifest),
    withVersion(readFileSync(join(tree, manifest), "utf8"), bump.from, bump.to, manifest),
  );

  if (bump.section !== null) {
    const changelog = `${bump.source}/${CHANGELOG}`;

    writeFileSync(
      join(tree, changelog),
      withSection(readFileSync(join(tree, changelog), "utf8"), bump.section),
    );
    files.push(changelog);
  }

  git(tree, ["add", "--", ...files]);

  const committed = run(["git", "commit", "--quiet", "-m", subjectOf(bump)], tree);

  return committed.ok
    ? null
    : `the commit ${subjectOf(bump)} failed:\n${committed.out}${committed.err}`;
}

function changedBetween(repo: PluginDir, from: CommitId, to: CommitId): readonly string[] {
  return git(repo, ["diff", "--name-only", "--no-renames", "-z", from, to])
    .split("\0")
    .filter((path) => path !== "");
}

/**
 * Why the bumps made on `base` cannot be rebased on `moved`, dev's head now; null when they can:
 * `main` still where the plan found it, `moved` above `base`, and no new commit under a plugin the
 * plan bumps or in a plugin it does not that now needs a bump.
 */
function movedRefusal(
  repo: PluginDir,
  plan: ReleasePlan,
  base: CommitId,
  moved: CommitId,
): string | null {
  const again = "run the dry-run again";
  const main = commitAt(repo, MAIN);

  if (main !== plan.shipped) return `main moved to ${short(main)} meanwhile: ${again}`;

  if (!run(["git", "merge-base", "--is-ancestor", base, moved], repo).ok) {
    return `dev's head ${short(moved)} does not hold ${short(base)}: ${again}`;
  }

  const dirs = plan.bumps.map(({ source }) => `${source}/`);

  const touched = changedBetween(repo, base, moved).filter((path) =>
    dirs.some((dir) => path.startsWith(dir)),
  );

  if (touched.length > 0) {
    return `dev moved to ${short(moved)} with changes to a plugin the plan bumps (${touched.join(", ")}): ${again}`;
  }

  const planned = new Set(plan.bumps.map(({ name }) => name));
  const added = unbumped(repo, plan.shipped, moved).filter(({ name }) => !planned.has(name));

  if (added.length > 0) {
    return `dev moved to ${short(moved)}, and ${added.map(({ name }) => name).join(", ")} now need a bump too: ${again}`;
  }

  return null;
}

const SAME_PLAN = "the same bun ./scripts/release.ts --plan <digest> applies again";

/** dev's head on the remote, fetched now: whether a refused push met a moved dev is read here, never from git's wording. */
function devHead(repo: PluginDir): CommitId {
  git(repo, ["fetch", "--quiet", REMOTE]);

  return commitAt(repo, DEFAULT_REF);
}

/** The tags the dry-run printed for `plan`: those of versions set already, and one per bump that keeps a changelog. */
function printedTags(repo: PluginDir, plan: ReleasePlan): ReadonlySet<TagName> {
  return new Set([
    ...plannedTags(repo, plan.shipped, plan.target).map(({ tag }) => tag),
    ...plan.bumps.flatMap(({ name, to, section }) =>
      section === null ? [] : [tagNameOf(name, to)],
    ),
  ]);
}

/**
 * Push the bump commits to dev, rebased first on dev's head, fetched just before, whenever it is not
 * their base: a push git would refuse as non-fast-forward still runs the whole pre-push hook. A
 * refused push is tried again when dev moved meanwhile, the pre-push hook's minutes included,
 * whatever git's message says. Refused when dev moved by commits the plan does not cover, or when
 * the rebased head would make a tag the plan did not print.
 */
function pushBumps(repo: PluginDir, tree: PluginDir, plan: ReleasePlan, context: Context): Bumped {
  const printed = printedTags(repo, plan);
  let base = plan.target;
  let dev = devHead(repo);

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    if (dev !== base) {
      const why = movedRefusal(repo, plan, base, dev);

      if (why !== null) return { kind: "refused", why };

      const rebased = run(["git", "rebase", "--quiet", dev], tree);

      if (!rebased.ok) {
        run(["git", "rebase", "--abort"], tree);

        return {
          kind: "refused",
          why: `the bumps do not rebase on ${DEV}'s ${short(dev)}: run the dry-run again\n${rebased.out}${rebased.err}`,
        };
      }

      base = dev;
    }

    const head = commitAt(tree, "HEAD");
    const tags = plannedTags(repo, plan.shipped, head);
    const unprinted = tags.filter(({ tag }) => !printed.has(tag));

    if (unprinted.length > 0) {
      return {
        kind: "refused",
        why: `${DEV} moved to ${short(base)}, and the release would tag ${unprinted.map(({ tag }) => tag).join(", ")}, which the plan did not print: run the dry-run again`,
      };
    }

    context.say(`pushing ${short(head)} to ${DEV}; its pre-push hook runs the gates and suites`);

    const pushed = run(["git", "push", "--quiet", REMOTE, `HEAD:refs/heads/${DEV}`], tree);

    if (pushed.ok) return { kind: "ready", head, tags };

    dev = devHead(repo);

    if (dev === base) {
      return {
        kind: "refused",
        why: `the push of the bumps to ${DEV} was refused, nothing moved; once what it names is fixed, ${SAME_PLAN}:\n${pushed.out}${pushed.err}`,
      };
    }
  }

  return {
    kind: "refused",
    why: `${DEV} moved during each of ${ATTEMPTS} attempts; ${SAME_PLAN}`,
  };
}

/** The bump commits, made in a temporary worktree on the plan's target and pushed to dev; the worktree removed whatever happens. */
function bumpOnDev(repo: PluginDir, plan: ReleasePlan, context: Context): Bumped {
  const scratch = mkdtempSync(join(tmpdir(), "release-bumps-"));
  const path = join(scratch, "tree");

  try {
    git(repo, ["worktree", "add", "--quiet", "--detach", path, plan.target]);

    const tree = pluginDirAt(path);

    if (tree === null) throw new Error(`git worktree add made no directory at ${path}`);

    context.say(`installing the root dependencies in ${path}, for the commit hooks`);

    const installed = run(["bun", "install", "--frozen-lockfile"], tree);

    if (!installed.ok)
      throw new Error(`bun install --frozen-lockfile in ${path}: ${installed.err}`);

    for (const bump of plan.bumps) {
      context.say(`committing ${subjectOf(bump)}`);

      const refusal = commitBump(tree, bump);

      if (refusal !== null) return { kind: "refused", why: refusal };
    }

    return pushBumps(repo, tree, plan, context);
  } finally {
    run(["git", "worktree", "remove", "--force", path], repo);
    rmSync(scratch, { recursive: true, force: true });
    run(["git", "worktree", "prune"], repo);
  }
}

/** Apply a sealed plan: the bumps on dev, CI green on their commit, then the release from there. */
export async function ship(
  repo: PluginDir,
  plan: ReleasePlan,
  context: Context,
): Promise<ShipOutcome> {
  const main = commitAt(repo, MAIN);

  if (main !== plan.shipped) {
    return {
      kind: "refused",
      why: `main is at ${short(main)}, not at ${short(plan.shipped)} as the plan found it: run the dry-run again`,
    };
  }

  const bumped: Bumped =
    plan.bumps.length === 0
      ? { kind: "ready", head: plan.target, tags: plannedTags(repo, plan.shipped, plan.target) }
      : bumpOnDev(repo, plan, context);

  if (bumped.kind === "refused") return bumped;

  const { head, tags } = bumped;
  const onDev = plan.bumps.length > 0;

  context.say(`waiting for the push run of CI on ${short(head)}`);

  let ci: CiOutcome;

  try {
    ci = await waitFor(context.gh, { sha: head, event: "push" }, context.limits);
  } catch (error) {
    if (!onDev) throw error;

    const why = error instanceof Error ? error.message : String(error);

    return { kind: "after-bumps", head, why: `waiting for its push run of CI failed: ${why}` };
  }

  if (ci.kind !== "green") return { kind: "ci-not-green", head, bumped: onDev, ci };

  const belowBumps = commitAt(repo, `${head}~${plan.bumps.length}`);

  if (belowBumps !== plan.target) {
    context.say(
      `main ${short(plan.shipped)} → ${short(head)}, past the plan's ${short(plan.target)} by:`,
    );

    for (const line of git(repo, [
      "log",
      "--reverse",
      "--format=%h %s",
      `${plan.target}..${belowBumps}`,
    ])
      .split("\n")
      .filter((commit) => commit !== "")) {
      context.say(`  ${line}`);
    }
  }

  const released = release(repo, head, tags);

  return released.kind === "push-refused" && onDev
    ? {
        kind: "after-bumps",
        head,
        why: `the push to main was refused, nothing tagged:\n${released.why}`,
      }
    : released;
}

function repositoryAt(cwd: string): PluginDir {
  const top = run(["git", "rev-parse", "--show-toplevel"], cwd);
  const root = top.ok ? pluginDirAt(top.out.trim()) : null;

  if (root === null) throw new Error(`not in a git working tree: ${cwd}`);

  return root;
}

/** What the command prints, and its exit code. */
export interface Report {
  readonly text: string;
  readonly exit: number;
}

type Format = Parameters<typeof styleText>[0];

/** How the text a person reads is drawn: its colours, none off a terminal, and the width it folds at. */
export interface View {
  readonly paint: (format: Format, text: string) => string;
  readonly width: number;
}

export const PLAIN: View = { paint: (_format, text) => text, width: MAX_WIDTH };

const LEVEL_FORMAT: Readonly<Record<Level, Format>> = {
  patch: "green",
  minor: "cyan",
  major: ["magenta", "bold"],
};

/** The view of a person's terminal; `FORCE_COLOR` keeps the colours through a wrapper that captures stdout. */
function terminalView(): View {
  const columns = process.stdout.isTTY
    ? process.stdout.columns
    : process.stderr.isTTY
      ? process.stderr.columns
      : MAX_WIDTH;

  return {
    paint: (format, text) => styleText(format, text, { stream: process.stdout }),
    // A pty with no size reports 0 columns.
    width: columns > 0 ? Math.min(columns, MAX_WIDTH) : MAX_WIDTH,
  };
}

/**
 * `text` folded at `width` between words, each word keeping the spacing after it, a line's
 * indentation and list marker carried by the lines it folds into. A line that fits and a fenced
 * block stay as they are: the person reads the text the plan commits.
 */
export function folded(text: string, width: number): readonly string[] {
  const lines: string[] = [];
  let fenced = false;

  for (const line of text.split("\n")) {
    const fence = line.trimStart().startsWith("```");

    if (fence) fenced = !fenced;

    if (fence || fenced || line.length <= width) {
      lines.push(line);
      continue;
    }

    const lead = /^\s*(?:[-*] )?/u.exec(line)?.[0] ?? "";
    const hang = " ".repeat(lead.length);
    const [first = "", ...rest] = line.slice(lead.length).split(/(?<=\s)(?=\S)/u);
    let current = `${lead}${first}`;

    for (const word of rest) {
      if (`${current}${word}`.trimEnd().length > width) {
        lines.push(current.trimEnd());
        current = `${hang}${word}`;
      } else {
        current = `${current}${word}`;
      }
    }

    lines.push(current.trimEnd());
  }

  return lines;
}

function labelled(label: string, value: string, view: View): string {
  return `${view.paint("dim", label.padEnd(LABEL_WIDTH))}${value}`;
}

function bumpRows(bumps: readonly PlannedBump[], view: View): readonly string[] {
  const widest = (key: "name" | "from" | "to") =>
    Math.max(...bumps.map((bump) => bump[key].length));

  const [name, from, to] = [widest("name"), widest("from"), widest("to")];

  return bumps.map((bump) => {
    const departs =
      bump.level === bump.codeLevel
        ? ""
        : `  ${view.paint("yellow", `⚠ subjects said ${bump.codeLevel}`)}`;

    return `  ${view.paint("bold", bump.name.padEnd(name))}  ${bump.from.padEnd(from)} → ${view.paint("bold", bump.to.padEnd(to))}  ${view.paint(LEVEL_FORMAT[bump.level], bump.level)}${departs}`;
  });
}

/** The bump's commit subject, Claude's reason when its level departs from the subjects', and its changelog section. */
function bumpDetail(bump: PlannedBump, view: View): readonly string[] {
  const title = `${bump.name} ${bump.to}`;
  const rule = view.paint("dim", "─".repeat(Math.max(3, view.width - title.length - 4)));

  const why =
    bump.level === bump.codeLevel
      ? []
      : folded(bump.reason, view.width - 7).map(
          (line, index) => `${index === 0 ? `  ${view.paint("dim", "why")}  ` : "       "}${line}`,
        );

  const bar = view.paint("dim", "│");

  const section =
    bump.section === null
      ? []
      : [
          `  ${view.paint("dim", CHANGELOG)}`,
          ...folded(bump.section.split("\n").slice(1).join("\n").trim(), view.width - 4).map(
            (line) => (line === "" ? `  ${bar}` : `  ${bar} ${line}`),
          ),
        ];

  return [
    "",
    `${view.paint("dim", "──")} ${view.paint("bold", title)} ${rule}`,
    `  ${subjectOf(bump)}`,
    ...why,
    ...section,
  ];
}

/** What applying `plan` would do, for a person to confirm; `tags` are those of versions set already. */
export function describePlan(
  plan: ReleasePlan,
  tags: readonly PlannedTag[],
  view: View = PLAIN,
): string {
  const tagLines = [
    ...tags.map(({ tag, commit, notes }) => {
      const sections = notes
        .split("\n")
        .filter((line) => line.startsWith("## "))
        .map((line) => line.slice("## ".length));

      return `${tag} on ${short(commit)}, with the sections ${sections.join(", ")}`;
    }),
    ...plan.bumps.flatMap(({ name, to, section }) =>
      section === null ? [] : [`${tagNameOf(name, to)} on its bump commit`],
    ),
  ];

  const tagged =
    tagLines.length === 0
      ? [labelled("Tags", "none: no plugin that keeps a changelog changes version", view)]
      : tagLines.map((line, index) =>
          index === 0 ? labelled("Tags", line, view) : `${" ".repeat(LABEL_WIDTH)}${line}`,
        );

  return [
    `${view.paint("bold", "Release")}  main ${short(plan.shipped)} → ${short(plan.target)}`,
    "",
    ...(plan.bumps.length === 0 ? ["  no plugin to bump"] : bumpRows(plan.bumps, view)),
    ...plan.bumps.flatMap((bump) => bumpDetail(bump, view)),
    "",
    ...tagged,
  ].join("\n");
}

const AGAIN_AFTER_BUMPS =
  "Next: bun ./scripts/release.ts --dry-run, then --plan <the digest it prints>; its plan finds these bumps made, so it only waits for CI and pushes main";

function describeCi({ head, bumped, ci }: Extract<ShipOutcome, { kind: "ci-not-green" }>): string {
  const where = bumped ? `The bumps are on ${DEV} at ${short(head)}; main` : "main";
  const next = bumped ? AGAIN_AFTER_BUMPS : "Then release again";

  switch (ci.kind) {
    case "red":
      return `CI is red on ${short(head)}: ${ci.red.map(({ url }) => url).join(", ")}. ${where} is unmoved. Re-run the red jobs (gh run rerun <run-id> --failed) or land a fix. ${next}.`;
    case "none":
      return `no push run of CI on ${short(head)}: only a push to ${DEV} starts one. ${where} is unmoved.`;
    case "timeout":
      return `CI still runs on ${short(head)} after ${CI_LIMITS.timeoutMs / 60_000} min: ${ci.running.map(({ url }) => url).join(", ")}. ${where} is unmoved; once it ends: ${next}.`;
  }
}

/** What the command prints for `outcome`, and its exit code. */
export function reportOf(outcome: ShipOutcome): Report {
  switch (outcome.kind) {
    case "refused":
      return { text: `nothing pushed: ${outcome.why}`, exit: 1 };
    case "ci-not-green":
      return { text: describeCi(outcome), exit: 1 };
    case "after-bumps":
      return {
        text: `The bumps are on ${DEV} at ${short(outcome.head)}; main is unmoved: ${outcome.why}\n${AGAIN_AFTER_BUMPS}.`,
        exit: 1,
      };
    case "released":
      return {
        text:
          outcome.tags.length === 0
            ? "main moved; no plugin that keeps a changelog changed version: nothing to tag"
            : outcome.tags.map(({ tag }) => `released ${tag}`).join("\n"),
        exit: 0,
      };
    case "push-refused":
      return { text: `the push to main was refused, nothing tagged:\n${outcome.why}`, exit: 1 };
    case "tag-failed":
      return {
        text: `main moved, but ${outcome.tag} failed at "${outcome.step}":\n${outcome.why}\nFinish that step by hand, then any tag after it.`,
        exit: 1,
      };
  }
}

/** A sealed plan with what the dry-run printed beside it. */
export interface DryRun {
  readonly plan: ReleasePlan;
  /** The tags of versions set already. */
  readonly tags: readonly PlannedTag[];
  readonly costUsd: number;
  readonly sealed: Sealed;
}

async function dryRun(
  repo: PluginDir,
  ref: string | null,
  onJudge: (event: JudgeEvent) => void,
): Promise<DryRun> {
  const shipped = commitAt(repo, MAIN);
  const head = commitAt(repo, DEFAULT_REF);
  const target = ref === null ? head : commitAt(repo, ref);
  const tags = plannedTags(repo, shipped, target);

  const { plan, costUsd } = await planRelease(
    repo,
    { shipped, target, head },
    localDate(new Date()),
    onJudge,
  );

  for (const { name, to } of plan.bumps) {
    const tag = tagNameOf(name, to);

    if (tagExists(repo, tag)) throw new Error(`${tag} exists already: a tag is never moved`);
  }

  return { plan, tags, costUsd, sealed: sealPlan(repo, plan) };
}

/** The dry-run for a person; its last line, `digest: <12 hex>`, uncoloured, is what release-plugins reads. */
export function describeDryRun(repo: PluginDir, drafted: DryRun, view: View = PLAIN): string {
  const { plan, tags, costUsd, sealed } = drafted;
  const inRepo = relative(repo, sealed.path);

  const cost =
    plan.bumps.length === 0
      ? []
      : [labelled("Cost", `$${costUsd.toFixed(2)} (${JUDGE_MODEL} × ${plan.bumps.length})`, view)];

  return [
    describePlan(plan, tags, view),
    ...cost,
    labelled("Plan", inRepo.startsWith("..") ? sealed.path : inRepo, view),
    `digest: ${sealed.digest}`,
  ].join("\n");
}

/** The dry-run for an agent: the sealed plan, each bump's commit subject and tag, and the tags of versions set already. */
export function dryRunJson(drafted: DryRun): string {
  const { plan, tags, costUsd, sealed } = drafted;

  return JSON.stringify(
    {
      shipped: plan.shipped,
      target: plan.target,
      digest: sealed.digest,
      plan: sealed.path,
      model: JUDGE_MODEL,
      costUsd,
      bumps: plan.bumps.map((bump) => ({
        ...bump,
        subject: subjectOf(bump),
        tag: bump.section === null ? null : tagNameOf(bump.name, bump.to),
      })),
      tags: tags.map(({ name, version, tag, commit, notes }) => ({
        name,
        version,
        tag,
        commit,
        notes,
      })),
    },
    null,
    2,
  );
}

function progress(line: string): void {
  console.error(styleText("dim", `· ${line}`, { stream: process.stderr }));
}

function judgeProgress(event: JudgeEvent): void {
  progress(
    event.kind === "judging"
      ? `judging ${event.plugins.join(", ")} with ${JUDGE_MODEL}`
      : `${event.plugin} judged in ${(event.ms / 1000).toFixed(1)} s`,
  );
}

if (import.meta.main) {
  const cli = parseCli(process.argv.slice(2));

  if (cli.kind === "usage") {
    console.error(USAGE);
    process.exit(2);
  }

  try {
    const repo = repositoryAt(process.cwd());

    git(repo, ["fetch", "--quiet", REMOTE]);

    if (cli.kind === "dry-run") {
      const drafted = await dryRun(repo, cli.ref, judgeProgress);

      console.log(cli.json ? dryRunJson(drafted) : describeDryRun(repo, drafted, terminalView()));
    } else {
      const outcome = await ship(repo, loadPlan(repo, cli.digest), {
        gh: ghCli,
        limits: CI_LIMITS,
        say: progress,
      });

      const { text, exit } = reportOf(outcome);

      console.log(styleText(exit === 0 ? "green" : "red", text, { stream: process.stdout }));
      process.exitCode = exit;
    }
  } catch (error) {
    const message = `release: ${error instanceof Error ? error.message : String(error)}`;

    console.error(styleText("red", message, { stream: process.stderr }));
    process.exitCode = 1;
  }
}
