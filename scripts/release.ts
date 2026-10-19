#!/usr/bin/env bun

/**
 * The release step, run by the human: bump each plugin changed since `main`, wait for CI on dev,
 * push `main`, then tag each plugin that keeps a `CHANGELOG.md` and shipped a new version, on the
 * commit that set it, and publish its GitHub Release.
 *
 *   bun ./scripts/release.ts --dry-run [<ref>]    # judge the bumps, print and seal the plan
 *   bun ./scripts/release.ts --plan <digest>      # apply the sealed plan whose digest was read
 *
 * The dry-run judges each bump with Claude (`release-plan.ts`) and writes nothing but the plan,
 * sealed under the git directory; `<ref>` (default: origin/dev) may be an older SHA only when
 * nothing needs a bump. The run applies that plan as it was read: one `chore(<plugin>): x.y.z,
 * <summary>` commit per bump, with its changelog section, made in a temporary worktree where the
 * commit hooks run, pushed to dev, rebased when dev moved by commits the plan does not need to
 * cover; then it waits for that commit's push run of CI to end green, and moves `main` there.
 * Everything is read and checked before a push: a changelog that does not parse, or a tag that
 * already exists, stops the release with `main` unmoved. The notes are the changelog's sections
 * newer than the version `main` held, written into the annotated tag, and the Release reads them
 * back from it. Never: a tag before the push landed, a tag moved.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { movedOn } from "./land.ts";
import { type PluginDir, pluginDirAt } from "./lib/plugin-sources.ts";
import {
  localDate,
  loadPlan,
  type PlannedBump,
  planRelease,
  type ReleasePlan,
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
  "Usage: bun ./scripts/release.ts --dry-run [<ref>]   # judge the bumps, print and seal the plan",
  "       bun ./scripts/release.ts --plan <digest>     # apply the sealed plan",
].join("\n");

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

/** What applying a plan ends on: refused with nothing moved, stopped on CI, or the release's own outcome. */
export type ShipOutcome =
  | { readonly kind: "refused"; readonly why: string }
  | {
      readonly kind: "ci-not-green";
      readonly head: CommitId;
      readonly bumped: boolean;
      readonly ci: Exclude<CiOutcome, { readonly kind: "green" }>;
    }
  | ReleaseOutcome;

/** What the command line asks: `--dry-run` anywhere among the arguments, as the landing guard reads it. */
export type Cli =
  | { readonly kind: "dry-run"; readonly ref: string | null }
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
    const [ref, ...extra] = args.filter((arg) => arg !== "--dry-run");

    return extra.length > 0 || ref?.startsWith("-") === true
      ? { kind: "usage" }
      : { kind: "dry-run", ref: ref ?? null };
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

/** Push the bump commits to dev, rebased on it when it moved by commits the plan needs not cover. */
function pushBumps(repo: PluginDir, tree: PluginDir, plan: ReleasePlan, context: Context): Bumped {
  let base = plan.target;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const head = commitAt(tree, "HEAD");
    const tags = plannedTags(repo, plan.shipped, head);

    context.say(`pushing ${short(head)} to ${DEV}; its pre-push hook runs the gates and suites`);

    const pushed = run(["git", "push", "--quiet", REMOTE, `HEAD:refs/heads/${DEV}`], tree);

    if (pushed.ok) return { kind: "ready", head, tags };

    if (!movedOn(pushed.err)) {
      return {
        kind: "refused",
        why: `the push of the bumps to ${DEV} was refused, nothing moved:\n${pushed.out}${pushed.err}`,
      };
    }

    git(repo, ["fetch", "--quiet", REMOTE]);

    const moved = commitAt(repo, DEFAULT_REF);
    const why = movedRefusal(repo, plan, base, moved);

    if (why !== null) return { kind: "refused", why };

    const rebased = run(["git", "rebase", "--quiet", moved], tree);

    if (!rebased.ok) {
      run(["git", "rebase", "--abort"], tree);

      return {
        kind: "refused",
        why: `the bumps do not rebase on ${DEV}'s ${short(moved)}: run the dry-run again\n${rebased.err}`,
      };
    }

    base = moved;
  }

  return {
    kind: "refused",
    why: `${DEV} moved during each of ${ATTEMPTS} attempts: run the release again`,
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

  context.say(`waiting for the push run of CI on ${short(bumped.head)}`);

  const ci = await waitFor(context.gh, { sha: bumped.head, event: "push" }, context.limits);

  if (ci.kind !== "green") {
    return { kind: "ci-not-green", head: bumped.head, bumped: plan.bumps.length > 0, ci };
  }

  return release(repo, bumped.head, bumped.tags);
}

function repositoryAt(cwd: string): PluginDir {
  const top = run(["git", "rev-parse", "--show-toplevel"], cwd);
  const root = top.ok ? pluginDirAt(top.out.trim()) : null;

  if (root === null) throw new Error(`not in a git working tree: ${cwd}`);

  return root;
}

/** What the command prints, and its exit code. */
interface Report {
  readonly text: string;
  readonly exit: number;
}

function describeBump(bump: PlannedBump): readonly string[] {
  const proposed =
    bump.codeLevel === bump.level ? "" : ` (the commit subjects propose ${bump.codeLevel})`;

  return [
    `${bump.name} ${bump.from} -> ${bump.to}, ${bump.level}${proposed}`,
    `  ${subjectOf(bump)}`,
    `  why: ${bump.reason}`,
    ...(bump.section === null
      ? []
      : bump.section.split("\n").map((line) => (line === "" ? "" : `    ${line}`))),
  ];
}

/** What applying `plan` would do, for a person to confirm; `tags` are those of versions set already. */
export function describePlan(plan: ReleasePlan, tags: readonly PlannedTag[]): string {
  const bumpTags = plan.bumps.flatMap(({ name, to, section }) =>
    section === null ? [] : [`${tagNameOf(name, to)} on its bump commit`],
  );

  const tagLines = tags.flatMap(({ tag, commit, notes }) => [
    `${tag} on ${short(commit)}, with the sections:`,
    ...notes
      .split("\n")
      .filter((line) => line.startsWith("## "))
      .map((line) => `  ${line.slice("## ".length)}`),
  ]);

  const tagged =
    tagLines.length + bumpTags.length === 0
      ? ["no plugin that keeps a changelog changes version: no tag"]
      : [...tagLines, ...bumpTags];

  return [
    `main ${short(plan.shipped)} -> ${short(plan.target)}`,
    ...(plan.bumps.length === 0 ? ["no plugin to bump"] : plan.bumps.flatMap(describeBump)),
    ...tagged,
  ].join("\n");
}

function describeCi({ head, bumped, ci }: Extract<ShipOutcome, { kind: "ci-not-green" }>): string {
  const where = bumped ? `The bumps are on ${DEV} at ${short(head)}; main` : "main";
  const after = bumped ? ": its plan has nothing left to bump" : "";

  switch (ci.kind) {
    case "red":
      return `CI is red on ${short(head)}: ${ci.red.map(({ url }) => url).join(", ")}. ${where} is unmoved. Re-run the red jobs (gh run rerun <run-id> --failed) or land a fix, then run the release again${after}.`;
    case "none":
      return `no push run of CI on ${short(head)}: only a push to ${DEV} starts one. ${where} is unmoved.`;
    case "timeout":
      return `CI still runs on ${short(head)} after ${CI_LIMITS.timeoutMs / 60_000} min: ${ci.running.map(({ url }) => url).join(", ")}. ${where} is unmoved; run the release again once it ends${after}.`;
  }
}

function describe(outcome: ShipOutcome): Report {
  switch (outcome.kind) {
    case "refused":
      return { text: `nothing pushed: ${outcome.why}`, exit: 1 };
    case "ci-not-green":
      return { text: describeCi(outcome), exit: 1 };
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

async function dryRun(repo: PluginDir, ref: string | null): Promise<string> {
  const shipped = commitAt(repo, MAIN);
  const head = commitAt(repo, DEFAULT_REF);
  const target = ref === null ? head : commitAt(repo, ref);
  const tags = plannedTags(repo, shipped, target);

  const { plan, costUsd } = await planRelease(
    repo,
    { shipped, target, head },
    localDate(new Date()),
    (plugin) => console.error(`release: judging ${plugin} with claude -p --model opus`),
  );

  for (const { name, to } of plan.bumps) {
    const tag = tagNameOf(name, to);

    if (tagExists(repo, tag)) throw new Error(`${tag} exists already: a tag is never moved`);
  }

  const sealed = sealPlan(repo, plan);
  const cost = plan.bumps.length === 0 ? [] : [`claude -p cost: $${costUsd.toFixed(2)}`];

  return [
    describePlan(plan, tags),
    ...cost,
    `plan: ${sealed.path}`,
    `digest: ${sealed.digest}`,
  ].join("\n");
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
      console.log(await dryRun(repo, cli.ref));
    } else {
      const outcome = await ship(repo, loadPlan(repo, cli.digest), {
        gh: ghCli,
        limits: CI_LIMITS,
        say: (line) => console.error(`release: ${line}`),
      });

      const { text, exit } = describe(outcome);

      console.log(text);
      process.exitCode = exit;
    }
  } catch (error) {
    console.error(`release: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
