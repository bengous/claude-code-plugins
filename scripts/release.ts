#!/usr/bin/env bun

/**
 * The release step, run by the human: bump each plugin changed since `main`, wait for CI on dev,
 * push `main`, then tag each plugin that keeps a `CHANGELOG.md` and shipped a new version, on the
 * commit that set it, and publish its GitHub Release.
 *
 *   bun ./scripts/release.ts --dry-run [--json] [<ref>]   # judge the bumps, print and seal the plan
 *   bun ./scripts/release.ts --plan <digest>              # apply the sealed plan whose digest was read, or resume it
 *
 * The dry-run judges each bump with Claude (`release-plan.ts`) and writes nothing but the plan,
 * sealed under the git directory; `--json` prints it as one JSON document, for an agent, in place
 * of the text a person reads. `<ref>` (default: origin/dev) may be an older SHA only when
 * nothing needs a bump. The run applies that plan as it was read. dev accepts no direct push, so
 * the bumps land through a pull request: one commit, `chore(release): <plugin>@x.y.z, ...`, with
 * each changelog section, made in a temporary worktree on dev's head where the commit hooks run,
 * pushed to `release/<target>`, opened against dev with a body that names the plan's digest and
 * that commit. The owner approves it by adding the `human-approved` label, which this script never
 * adds. The script waits, bounded, until GitHub calls the pull request mergeable (the label on, the
 * required checks green), checks dev's head, and squash-merges that one commit itself; GitHub's
 * squash commit carries the title and sets every bumped version. A run of the same plan finds the
 * pull request by its branch and its digest, open or merged, and resumes; a conflict, a head the
 * script did not push, or dev moving by commits the plan does not cover leaves it unmerged, to be
 * closed and planned again. Past the merge, it waits for the squash commit's push run of CI to end
 * green, prints each commit dev moved by past the plan's target, and moves `main` there.
 * A changelog that does not parse, or a tag that already exists, stops the release with `main`
 * unmoved. The notes are the changelog's sections newer than the version `main` held, written into
 * the annotated tag, and the Release reads them back from it. Never: a tag before `main` moved, a
 * tag moved.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { styleText } from "node:util";

import { writeAtomicSync } from "../tools/platform/fs.ts";
import { messageOf } from "../tools/platform/pure.ts";
import { type CiOutcome, type Gh, ghCli, type WaitLimits, waitFor } from "./landing/ci-wait.ts";
import { type PluginDir, pluginDirAt } from "./lib/plugin-sources.ts";
import { run as command } from "./lib/run.ts";
import {
  CHANGELOG,
  notesSince,
  parseChangelog,
  type Semver,
  semverOf,
  versionCommits,
} from "./releasing/changelog.ts";
import {
  catalogAt,
  type CommitId,
  commitAt,
  type MarketplaceName,
  unbumped,
  versionAt,
} from "./releasing/check-plugin-bumps.ts";
import {
  type JudgeEvent,
  JUDGE_MODEL,
  type Level,
  localDate,
  loadPlan,
  type PlannedBump,
  planDigest,
  planRelease,
  type ReleasePlan,
  type Sealed,
  sealPlan,
  withSection,
  withVersion,
} from "./releasing/release-plan.ts";
import {
  type ListedPull,
  type MergeWait,
  openPull,
  pullFrom,
  pullsFrom,
  type PullRequest,
  type PullView,
  squashMerge,
  viewOf,
  waitForMergeable,
} from "./releasing/release-pull.ts";

const REMOTE = "origin";

const MAIN = `${REMOTE}/main`;

const DEV = "dev";

const DEFAULT_REF = `${REMOTE}/${DEV}`;

const MANIFEST = ".claude-plugin/plugin.json";

const RELEASE_BRANCH = "release/";

const APPROVAL_LABEL = "human-approved";

/** The required check of the agent review: red on a finding, which a re-run reads the same. */
const REVIEW = "review";

/** The job that runs the reviewer: red when the reviewer itself failed, which leaves `review` red with no finding. */
const REVIEW_READ = "review (read)";

const CI_LIMITS: WaitLimits = { timeoutMs: 30 * 60_000, pollMs: 15_000 };

const MERGE_LIMITS: WaitLimits = { timeoutMs: 60 * 60_000, pollMs: 15_000 };

const USAGE = [
  "Usage: bun ./scripts/release.ts --dry-run [--json] [<ref>]   # judge the bumps, print and seal the plan",
  "       bun ./scripts/release.ts --plan <digest>              # apply the sealed plan through a pull request it merges once approved, or resume it",
].join("\n");

const MAX_WIDTH = 100;

const LABEL_WIDTH = 8;

/** An annotated tag's name, `<marketplace name>-v<x.y.z>`. */
export type TagName = string & { readonly __brand: "TagName" };

export interface PlannedTag {
  readonly name: MarketplaceName;
  readonly version: Semver;
  readonly tag: TagName;
  /**
   * The last commit that set `version`: the tag goes there, not on the release head, nor on an
   * earlier commit that set it before a revert.
   */
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
 * Why the release pull request was left unmerged: its wait's end, dev moved under the plan, or a
 * merge whose call failed or whose result did not read back, which GitHub may have done.
 */
export type MergeStop =
  | Exclude<MergeWait, { readonly kind: "merged" | "mergeable" }>
  | { readonly kind: "drift"; readonly why: string }
  | { readonly kind: "merge-unsure"; readonly why: string };

/**
 * What applying a plan ends on: refused with nothing moved, the release pull request left unmerged,
 * its squash commit on dev with what the plan did not judge, stopped on CI, stopped with the bumps
 * on dev and main unmoved, or the release's own outcome.
 */
export type ShipOutcome =
  | { readonly kind: "refused"; readonly why: string }
  | { readonly kind: "not-merged"; readonly pr: PullRequest; readonly wait: MergeStop }
  | {
      readonly kind: "unplanned";
      readonly head: string;
      readonly why: string;
      /** The commits dev gained past the plan's target, under the squash commit. */
      readonly commits: readonly string[];
    }
  | {
      readonly kind: "ci-not-green";
      readonly head: CommitId;
      readonly bumped: boolean;
      readonly ci: Exclude<CiOutcome, { readonly kind: "green" }>;
    }
  | { readonly kind: "after-bumps"; readonly head: string; readonly why: string }
  | ReleaseOutcome;

/** What the command line asks: `--dry-run` anywhere among the arguments. */
export type Cli =
  | { readonly kind: "dry-run"; readonly ref: string | null; readonly json: boolean }
  | { readonly kind: "apply"; readonly digest: string }
  | { readonly kind: "usage" };

export interface Context {
  readonly gh: Gh;
  /** The wait for the push run of CI on the commit `main` moves to. */
  readonly limits: WaitLimits;
  /** The wait for the release pull request to become mergeable. */
  readonly mergeLimits: WaitLimits;
  readonly say: (line: string) => void;
}

/** The commit `main` moves to once its push run is green, with the tags planned on it; or why there is none. */
type Bumped =
  | { readonly kind: "ready"; readonly head: CommitId; readonly tags: readonly PlannedTag[] }
  | Extract<ShipOutcome, { readonly kind: "refused" | "not-merged" | "unplanned" | "after-bumps" }>;

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
  const result = command(
    cmd,
    cwd,
    stdin === undefined ? undefined : new TextEncoder().encode(stdin),
  );

  return { ok: result.ok, out: Buffer.from(result.raw).toString(), err: result.err };
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

    const set = versionCommits(repo, source, target).findLast((found) => found.version === version);

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

/** The bump's line in the release pull request, with Claude's summary. */
export function subjectOf(bump: PlannedBump): string {
  return `chore(${bump.name}): ${bump.to}, ${bump.summary}`;
}

/**
 * The release pull request's title, which GitHub gives its squash commit: every bump as
 * `<plugin>@x.y.z`, as `VERSION_BUMP` in `scripts/reports/sample-review.ts` reads it.
 */
export function titleOf(bumps: readonly PlannedBump[]): string {
  return `chore(release): ${bumps.map(({ name, to }) => `${name}@${to}`).join(", ")}`;
}

/** The release pull request's branch, named for the commit the plan releases. */
export function branchOf(plan: ReleasePlan): string {
  return `${RELEASE_BRANCH}${plan.target.slice(0, 12)}`;
}

/** What ties a release pull request to its plan and to the one commit the release pushed. */
interface Marker {
  readonly digest: string;
  readonly commit: string;
}

const MARKER = /^<!-- release\.ts: plan ([0-9a-f]{12}), commit ([0-9a-f]{40}|[0-9a-f]{64}) -->$/mu;

function markerOf(body: string): Marker | null {
  const [, digest, commit] = MARKER.exec(body) ?? [];

  return digest === undefined || commit === undefined ? null : { digest, commit };
}

function bodyOf(plan: ReleasePlan, { digest, commit }: Marker): string {
  return [
    `The bumps of the release from \`main\` ${short(plan.shipped)} to \`dev\` ${short(plan.target)}, made by \`scripts/release.ts\`:`,
    "",
    ...plan.bumps.map((bump) => `- ${subjectOf(bump)}`),
    "",
    `The \`${APPROVAL_LABEL}\` label is the owner's to add. Once it is on and the required checks are green, the release squash-merges ${short(commit)}, waits for the push run of CI on the squash commit, moves \`main\` there and tags it. It merges no other head: a push to this branch changes what was planned.`,
    "",
    `<!-- release.ts: plan ${digest}, commit ${commit} -->`,
  ].join("\n");
}

function closeCommand(pr: PullRequest, why: string): string {
  return `gh pr close ${pr.number} --delete-branch --comment "${why}"`;
}

/** Why the bumps' commit failed, its hooks' output included; null once it is made. */
function commitBumps(tree: PluginDir, plan: ReleasePlan, title: string): string | null {
  const files = plan.bumps.flatMap((bump) => {
    const manifest = `${bump.source}/${MANIFEST}`;

    writeAtomicSync(
      join(tree, manifest),
      withVersion(readFileSync(join(tree, manifest), "utf8"), bump.from, bump.to, manifest),
    );

    if (bump.section === null) return [manifest];

    const changelog = `${bump.source}/${CHANGELOG}`;

    writeAtomicSync(
      join(tree, changelog),
      withSection(readFileSync(join(tree, changelog), "utf8"), bump.section),
    );

    return [manifest, changelog];
  });

  git(tree, ["add", "--", ...files]);

  const lines = plan.bumps.map((bump) => subjectOf(bump)).join("\n");
  const committed = run(["git", "commit", "--quiet", "-m", title, "-m", lines], tree);

  return committed.ok ? null : `the commit ${title} failed:\n${committed.out}${committed.err}`;
}

/** `git log --format="%h %s"` of `range`, oldest first, limited to `paths` when given. */
function logLines(
  repo: PluginDir,
  range: string,
  paths: readonly string[] = [],
): readonly string[] {
  const pathspec = paths.length === 0 ? [] : ["--", ...paths];

  return git(repo, ["log", "--reverse", "--format=%h %s", range, ...pathspec])
    .split("\n")
    .filter((line) => line !== "");
}

/**
 * Why the plan's bumps cannot land above `moved`, where dev went from the plan's target `base`;
 * null when they can: `moved` above `base`, and no new commit under a plugin the plan bumps or in a
 * plugin it does not that now needs a bump.
 */
function movedRefusal(
  repo: PluginDir,
  plan: ReleasePlan,
  base: CommitId,
  moved: CommitId,
): string | null {
  const again = "run the dry-run again";

  if (!run(["git", "merge-base", "--is-ancestor", base, moved], repo).ok) {
    return `dev's head ${short(moved)} does not hold ${short(base)}: ${again}`;
  }

  const under = logLines(
    repo,
    `${base}..${moved}`,
    plan.bumps.map(({ source }) => `${source}/`),
  );

  if (under.length > 0) {
    return `dev moved to ${short(moved)} with commits under a plugin the plan bumps (${under.join("; ")}): ${again}`;
  }

  const planned = new Set(plan.bumps.map(({ name }) => name));
  const added = unbumped(repo, plan.shipped, moved).filter(({ name }) => !planned.has(name));

  if (added.length > 0) {
    return `dev moved to ${short(moved)}, and ${added.map(({ name }) => name).join(", ")} now need a bump too: ${again}`;
  }

  return null;
}

const SAME_PLAN = "the same bun ./scripts/release.ts --plan <digest> applies again";

/** dev's head on the remote, fetched now, `main` with it. */
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
 * Why `main` cannot move to `head`, whose bumps sit above `moved`, where dev went from the plan's
 * target; null when it can. Reads `main` as last fetched.
 */
function driftRefusal(
  repo: PluginDir,
  plan: ReleasePlan,
  moved: CommitId,
  head: CommitId,
): string | null {
  const main = commitAt(repo, MAIN);

  if (main !== plan.shipped) return `main moved to ${short(main)} meanwhile: run the dry-run again`;

  const why = moved === plan.target ? null : movedRefusal(repo, plan, plan.target, moved);

  if (why !== null) return why;

  const printed = printedTags(repo, plan);

  const unprinted = plannedTags(repo, plan.shipped, head).filter(({ tag }) => !printed.has(tag));

  return unprinted.length === 0
    ? null
    : `${DEV} moved to ${short(moved)}, and the release would tag ${unprinted.map(({ tag }) => tag).join(", ")}, which the plan did not print: run the dry-run again`;
}

type Pushed =
  | { readonly kind: "pushed"; readonly commit: CommitId }
  | { readonly kind: "refused"; readonly why: string };

/**
 * The bumps' commit, made in a temporary worktree on `base` and pushed to `branch`; the worktree
 * removed whatever happens. Refused when a pull request from `branch` is open by then, or when the
 * branch holds anything but the head of a closed one: another run of the plan may be about to open
 * its pull request on it. The push replaces only that closed head, or needs the branch absent, as
 * read just before: a push meanwhile fails it.
 */
async function pushBumps(
  repo: PluginDir,
  plan: ReleasePlan,
  base: CommitId,
  branch: string,
  context: Context,
): Promise<Pushed> {
  const title = titleOf(plan.bumps);
  const scratch = mkdtempSync(join(tmpdir(), "release-bumps-"));
  const path = join(scratch, "tree");

  try {
    git(repo, ["worktree", "add", "--quiet", "--detach", path, base]);

    const tree = pluginDirAt(path);

    if (tree === null) throw new Error(`git worktree add made no directory at ${path}`);

    context.say(`installing the root dependencies in ${path}, for the commit hooks`);

    const installed = run(["bun", "install", "--frozen-lockfile"], tree);

    if (!installed.ok)
      throw new Error(`bun install --frozen-lockfile in ${path}: ${installed.err}`);

    context.say(`committing ${title}`);

    const refusal = commitBumps(tree, plan, title);

    if (refusal !== null) return { kind: "refused", why: refusal };

    const commit = commitAt(tree, "HEAD");
    const pulls = await pullsFrom(context.gh, branch, DEV);
    const open = pulls.find(({ state }) => state === "OPEN");

    if (open !== undefined) {
      return {
        kind: "refused",
        why: `${open.url}, from ${branch}, opened meanwhile, by another run of this plan; nothing pushed: ${SAME_PLAN} and resumes it`,
      };
    }

    const held = (
      git(repo, ["ls-remote", REMOTE, `refs/heads/${branch}`]).split("\t")[0] ?? ""
    ).trim();

    const closedHead = pulls.some(
      ({ state, headRefOid }) => state === "CLOSED" && headRefOid === held,
    );

    if (held !== "" && !closedHead) {
      return {
        kind: "refused",
        why: `${branch} holds ${short(held)}, the head of no closed pull request from it: another run of this plan may have pushed it and be opening its pull request; nothing pushed: ${SAME_PLAN} and resumes that pull request once it is open, or delete the branch (git push ${REMOTE} --delete ${branch}) if nothing uses it`,
      };
    }

    context.say(
      `pushing ${short(commit)} to ${branch}; its pre-push hook runs the gates and suites`,
    );

    const pushed = run(
      [
        "git",
        "push",
        "--quiet",
        `--force-with-lease=refs/heads/${branch}:${held}`,
        REMOTE,
        `HEAD:refs/heads/${branch}`,
      ],
      tree,
    );

    return pushed.ok
      ? { kind: "pushed", commit }
      : {
          kind: "refused",
          why: `the push of the bumps to ${branch} was refused, nothing moved; once what it names is fixed, ${SAME_PLAN}:\n${pushed.out}${pushed.err}`,
        };
  } finally {
    run(["git", "worktree", "remove", "--force", path], repo);
    rmSync(scratch, { recursive: true, force: true });
    run(["git", "worktree", "prune"], repo);
  }
}

/** The release pull request to wait on, the commit the release pushed to it, and whether it merged already; or why none. */
type Opened =
  | { readonly kind: "open"; readonly pr: PullRequest; readonly pushed: string }
  | {
      readonly kind: "merged";
      readonly pr: PullRequest;
      readonly pushed: string;
      readonly commit: string;
      readonly head: string;
    }
  | { readonly kind: "refused"; readonly why: string };

/** The pull request a run of a plan opened from `branch`, taken up only when its marker names this plan. */
function resumed(found: ListedPull, digest: string): Opened {
  const marker = markerOf(found.body);

  if (marker !== null && marker.digest === digest) {
    return found.state === "MERGED"
      ? {
          kind: "merged",
          pr: found,
          pushed: marker.commit,
          commit: found.mergeCommit,
          head: found.headRefOid,
        }
      : { kind: "open", pr: found, pushed: marker.commit };
  }

  const theirs = marker?.digest;
  const whose = theirs === undefined ? "no plan of release.ts" : `the plan ${theirs}`;
  const own = theirs === undefined ? "" : `bun ./scripts/release.ts --plan ${theirs}`;

  if (found.state === "MERGED") {
    return {
      kind: "refused",
      why: `${found.url} merged the bumps of ${whose}, not of the plan ${digest}: ${own === "" ? "" : `carry that release on with ${own}, or `}run the dry-run again`,
    };
  }

  return {
    kind: "refused",
    why: `${found.url} holds the bumps of ${whose}, not of the plan ${digest}: close it (${closeCommand(found, "replaced by another release plan")}), then ${SAME_PLAN}${own === "" ? "" : `; or apply its own plan: ${own}`}`,
  };
}

/** A new release pull request: the bumps' commit on dev's head, refused when dev moved by commits the plan does not cover. */
async function openRelease(
  repo: PluginDir,
  plan: ReleasePlan,
  branch: string,
  digest: string,
  context: Context,
): Promise<Opened> {
  const dev = devHead(repo);
  const drift = driftRefusal(repo, plan, dev, dev);

  if (drift !== null) return { kind: "refused", why: drift };

  const pushed = await pushBumps(repo, plan, dev, branch, context);

  if (pushed.kind === "refused") return pushed;

  const pr = await openPull(context.gh, {
    base: DEV,
    branch,
    title: titleOf(plan.bumps),
    body: bodyOf(plan, { digest, commit: pushed.commit }),
  });

  context.say(`opened ${pr.url}`);

  return { kind: "open", pr, pushed: pushed.commit };
}

async function mergeableOf(pr: PullRequest, pushed: string, context: Context): Promise<MergeWait> {
  context.say(
    `${pr.url}: add the label ${APPROVAL_LABEL} yourself, your approval, which this script never adds; once it is on and the required checks are green, the script merges ${short(pushed)}. It waits ${context.mergeLimits.timeoutMs / 60_000} min at most`,
  );

  try {
    return await waitForMergeable(context.gh, pr, pushed, context.mergeLimits);
  } catch (error) {
    return { kind: "failed", why: messageOf(error) };
  }
}

/**
 * The squash commit of a merged release pull request, checked: its head the commit the release
 * pushed, and dev under it moved by nothing the plan does not cover. An error past the merge says
 * the bumps are on dev.
 */
function afterMerge(
  repo: PluginDir,
  plan: ReleasePlan,
  merged: { readonly commit: string; readonly head: string; readonly pushed: string },
): Bumped {
  try {
    git(repo, ["fetch", "--quiet", REMOTE]);

    const squash = commitAt(repo, merged.commit);

    if (merged.head !== merged.pushed) {
      return {
        kind: "unplanned",
        head: squash,
        why: `the pull request merged the head ${short(merged.head)}, not ${short(merged.pushed)}, the commit this script pushed`,
        commits: [],
      };
    }

    const below = commitAt(repo, `${squash}~1`);
    const drift = driftRefusal(repo, plan, below, squash);

    if (drift !== null) {
      return {
        kind: "unplanned",
        head: squash,
        why: drift,
        commits: logLines(repo, `${plan.target}..${below}`),
      };
    }

    return { kind: "ready", head: squash, tags: plannedTags(repo, plan.shipped, squash) };
  } catch (error) {
    return { kind: "after-bumps", head: merged.commit, why: messageOf(error) };
  }
}

/**
 * Merge the release pull request once mergeable: dev's head checked first, nothing merged when dev
 * moved by commits the plan does not cover; then a squash merge of the one head the release pushed.
 */
async function mergeRelease(
  repo: PluginDir,
  plan: ReleasePlan,
  pr: PullRequest,
  pushed: string,
  context: Context,
): Promise<Bumped> {
  const dev = devHead(repo);
  const drift = driftRefusal(repo, plan, dev, dev);

  if (drift !== null) return { kind: "not-merged", pr, wait: { kind: "drift", why: drift } };

  context.say(`merging ${short(pushed)} into ${DEV} through ${pr.url}`);

  let view: PullView;

  try {
    await squashMerge(context.gh, pr, pushed);
    view = await viewOf(context.gh, pr);
  } catch (error) {
    return { kind: "not-merged", pr, wait: { kind: "merge-unsure", why: messageOf(error) } };
  }

  if (view.state !== "MERGED") {
    return {
      kind: "not-merged",
      pr,
      wait: {
        kind: "merge-unsure",
        why: `gh pr merge returned, and the pull request reads ${view.state}`,
      },
    };
  }

  return afterMerge(repo, plan, { commit: view.mergeCommit, head: view.headRefOid, pushed });
}

/**
 * The plan's bumps on dev through the release pull request: the one a run of this plan opened, open
 * or merged, or a new one; merged by this script once GitHub calls it mergeable.
 */
async function bumpOnDev(repo: PluginDir, plan: ReleasePlan, context: Context): Promise<Bumped> {
  const branch = branchOf(plan);
  const digest = planDigest(plan);
  const found = await pullFrom(context.gh, branch, DEV);

  const opened =
    found === null
      ? await openRelease(repo, plan, branch, digest, context)
      : resumed(found, digest);

  switch (opened.kind) {
    case "refused":
      return opened;
    case "merged":
      context.say(`${opened.pr.url} merged already, as ${short(opened.commit)}`);

      return afterMerge(repo, plan, opened);
    case "open":
      break;
  }

  if (found !== null) context.say(`resuming the wait for ${opened.pr.url}`);

  const wait = await mergeableOf(opened.pr, opened.pushed, context);

  switch (wait.kind) {
    case "merged":
      return afterMerge(repo, plan, { ...wait, pushed: opened.pushed });
    case "mergeable":
      return mergeRelease(repo, plan, opened.pr, opened.pushed, context);
    default:
      return { kind: "not-merged", pr: opened.pr, wait };
  }
}

/** Apply a sealed plan: the bumps on dev through a pull request, CI green on their commit, then the release from there. */
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
      : await bumpOnDev(repo, plan, context);

  if (bumped.kind !== "ready") return bumped;

  const { head, tags } = bumped;
  const onDev = plan.bumps.length > 0;

  context.say(`waiting for the push run of CI on ${short(head)}`);

  let ci: CiOutcome;

  try {
    ci = await waitFor(context.gh, { sha: head, event: "push" }, context.limits);
  } catch (error) {
    if (!onDev) throw error;

    const why = messageOf(error);

    return { kind: "after-bumps", head, why: `waiting for its push run of CI failed: ${why}` };
  }

  if (ci.kind !== "green") return { kind: "ci-not-green", head, bumped: onDev, ci };

  const belowBumps = onDev ? commitAt(repo, `${head}~1`) : head;

  if (belowBumps !== plan.target) {
    context.say(
      `main ${short(plan.shipped)} → ${short(head)}, past the plan's ${short(plan.target)} by:`,
    );

    for (const line of logLines(repo, `${plan.target}..${belowBumps}`)) context.say(`  ${line}`);
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

/** The bump's line, Claude's reason when its level departs from the subjects', and its changelog section. */
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

  const commit = plan.bumps.length === 0 ? [] : [labelled("Commit", titleOf(plan.bumps), view)];

  return [
    `${view.paint("bold", "Release")}  main ${short(plan.shipped)} → ${short(plan.target)}`,
    "",
    ...(plan.bumps.length === 0 ? ["  no plugin to bump"] : bumpRows(plan.bumps, view)),
    ...plan.bumps.flatMap((bump) => bumpDetail(bump, view)),
    "",
    ...commit,
    ...tagged,
  ].join("\n");
}

const AGAIN_AFTER_BUMPS =
  "Next: bun ./scripts/release.ts --dry-run, then --plan <the digest it prints>; its plan finds these bumps made, so it only waits for CI and pushes main";

const AGAIN_AFTER_MERGE =
  "Next: the same bun ./scripts/release.ts --plan <digest>; it finds its pull request merged, checks the squash commit again, waits for CI and moves main";

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

function describeWait({ pr, wait }: Extract<ShipOutcome, { kind: "not-merged" }>): string {
  const at = `The release pull request #${pr.number} (${pr.url})`;
  const replan = (why: string) => `Close it (${closeCommand(pr, why)}), then run the dry-run again`;

  switch (wait.kind) {
    case "closed":
      return `${at} was closed without merging; dev and main are unmoved: ${SAME_PLAN} and opens a new one, or run the dry-run again if the plan should change.`;
    case "conflict":
      return `${at} conflicts with ${DEV}; nothing merged, main unmoved. ${replan("conflicts with dev")}: its plan bumps on ${DEV}'s head.`;
    case "drift":
      return `${at} is mergeable, but nothing merged and main is unmoved: ${wait.why}. ${replan("dev moved under the release plan")}: its plan judges what ${DEV} gained.`;
    case "foreign-head":
      return `${at} has the head ${short(wait.head)}, not ${short(wait.pushed)}, the commit this script pushed; nothing merged, main unmoved. A push to its branch changes what was planned. ${replan("its head is not the release's commit")}.`;
    case "red": {
      const red = wait.checks.map(({ name, url }) => `${name} red (${url})`).join(", ");

      const names = new Set(wait.checks.map(({ name }) => name));

      const read =
        names.has(REVIEW) && !names.has(REVIEW_READ)
          ? "The review found something: read its comments on the pull request; running it again gives the same verdict."
          : `Read the failed runs. A flaky job: re-run it (gh run rerun <run-id> --failed), then ${SAME_PLAN} and resumes the wait.`;

      return `${at} has ${red}; nothing merged, main unmoved. ${read} A fix lands on ${DEV} on its own, not on this branch, whose head this script refuses unless it pushed it. ${replan("a fix lands first")}.`;
    }

    case "timeout":
      return `${at} is not mergeable after ${MERGE_LIMITS.timeoutMs / 60_000} min (${wait.status}); nothing merged, main unmoved. Once ${APPROVAL_LABEL} is on it and its required checks are green, ${SAME_PLAN} and resumes the wait.`;
    case "failed":
      return `${at}: waiting for it failed: ${wait.why}. Nothing merged, main unmoved; ${SAME_PLAN} and resumes the wait.`;
    case "merge-unsure":
      return `${at} may have merged: ${wait.why}. The bumps may already be on ${DEV}; main is unmoved. The same bun ./scripts/release.ts --plan <digest> finds the pull request merged and carries on from its commit, or resumes the wait if it did not merge.`;
  }
}

function describeUnplanned({
  head,
  why,
  commits,
}: Extract<ShipOutcome, { kind: "unplanned" }>): string {
  const gained =
    commits.length === 0
      ? ""
      : ` Past the plan's target, ${DEV} gained under it: ${commits.join("; ")}.`;

  return `The release commit ${short(head)} is on ${DEV}, and main is unmoved: ${why}.${gained} Moving main there would ship what the plan did not judge. Revert ${short(head)} on ${DEV} through a pull request (git revert ${head}), then run the dry-run again: the revert resets the versions, so the next plan judges everything.`;
}

/** What the command prints for `outcome`, and its exit code. */
export function reportOf(outcome: ShipOutcome): Report {
  switch (outcome.kind) {
    case "refused":
      return { text: `nothing pushed: ${outcome.why}`, exit: 1 };
    case "not-merged":
      return { text: describeWait(outcome), exit: 1 };
    case "unplanned":
      return { text: describeUnplanned(outcome), exit: 1 };
    case "ci-not-green":
      return { text: describeCi(outcome), exit: 1 };
    case "after-bumps":
      return {
        text: `The bumps are on ${DEV} at ${short(outcome.head)}; main is unmoved: ${outcome.why}\n${AGAIN_AFTER_MERGE}.`,
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

/**
 * The dry-run for an agent: the sealed plan, the release commit's subject, each bump's line and
 * tag, and the tags of versions set already.
 */
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
      title: plan.bumps.length === 0 ? null : titleOf(plan.bumps),
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
        mergeLimits: MERGE_LIMITS,
        say: progress,
      });

      const { text, exit } = reportOf(outcome);

      console.log(styleText(exit === 0 ? "green" : "red", text, { stream: process.stdout }));
      process.exitCode = exit;
    }
  } catch (error) {
    const message = `release: ${messageOf(error)}`;

    console.error(styleText("red", message, { stream: process.stderr }));
    process.exitCode = 1;
  }
}
