#!/usr/bin/env bun

/**
 * Land a reviewed branch, a pull request or a stack on `dev`: the "Land a
 * branch" procedure of `docs/repo-ops/git.md` as one command an agent runs
 * once, in the background, without a prompt. It waits by itself and ends on
 * one verdict line.
 *
 *   bun ./scripts/land.ts <feature/...|fix/...|renovate/...|chore/claude-code-types|n|#n> [--dry-run]
 *   bun ./scripts/land.ts --worker --once
 *
 * `--worker --once` is one pass of the landing worker (`scripts/landing/worker.ts`): what carries `land-ok` or
 * `tier:low` lands, each target through a run of this script of its own, without a session.
 *
 * A number is a pull request or a GitHub stack (`scripts/landing/stack.ts`).
 * A pull request, or a branch whose pull request, based on `dev`, lands as
 * described below. One based on another branch lands with the open pull
 * requests under it down to `dev`, and a stack with its open layers, as one
 * stack: see the last paragraph. `--dry-run` runs every check that comes
 * before the lock, writes nothing to GitHub or to a checkout, adds no
 * checkout, reads the tier from the pull request's `tier:` label without the
 * judge, prints what it would do, and exits 0, or 1 on the first refusal. A
 * human tier that waits for the human's `/land` is named in the plan, not
 * refused, so the plan shows every other check.
 *
 * Runs `origin/dev`'s copy of itself, on the arguments as given: after a
 * fetch, `origin/dev`'s whole tree is extracted to a temporary directory and
 * this script run there, so a branch that edits the landing lands under the
 * rule already on `dev`.
 *
 * Refused before any push: a branch outside `feature/`, `fix/`, `renovate/`
 * and `chore/claude-code-types`, the types branch held where the types run
 * recreates its worktree, tracked changes in the checkout holding the branch,
 * a pull request not open against `dev`, or whose head is not the local head
 * within a minute. No checkout holding the branch: one is added under
 * `.claude/worktrees/land-<branch>`, its lockfile installed, and removed once
 * the landing ends. A clean checkout behind its pull request's head is
 * fast-forwarded to it first.
 *
 * The tier: a `feature/` or `fix/` branch is tiered by the `tier.ts` beside
 * this script, so `origin/dev`'s, once per landing, on the change from the
 * pull request's base to the head the landing starts from, and checked on the
 * pull request read before and after the wait for CI; a `tier:human` label
 * already on the pull request keeps it human. The pull request gets the label
 * of its tier. A human one lands only with a `land-ok` label given to its
 * change: the head GitHub held when the label was added, by its push times,
 * has the patch, against the pull request's base, of the head the landing
 * starts from. Only the human puts the label on, by their own `/land <n>`
 * (`.claude/skills/land`) or by hand on GitHub, and the agent-hooks guard
 * refuses an agent that adds it. A `land-ok` whose change is no longer the head's
 * comes off, with a comment naming the commits since and GitHub's compare view
 * of the two heads: the human reads those alone, then types `/land <n>` again,
 * which adds the label anew. A low one without it is refused while a `red-dev`
 * issue is open.
 * Renovate's branches and the types branch have guards of their own.
 *
 * Before any wait, refused unless the pull request shows the head, its tier
 * lets it land, and a branch that touches a path of `origin/dev`'s
 * `profile.review.risky` carries a clean review verdict for its patch on the
 * pull request (`scripts/landing/review-verdict.ts`); while that profile does
 * not read, every path is risky. Then it takes the landing lock
 * (`scripts/landing/landing-lock.ts`), which every checkout of the repository
 * on this machine shares, waited for an hour at most and held to the end; the
 * pre-push hook refuses any other push to `dev` meanwhile.
 *
 * Then it waits, an hour at most in all, until
 * every `ci.yml` run of that head is green (`scripts/landing/ci-wait.ts`), a run red
 * in its e2e jobs alone re-run once. A branch touching the e2e paths whose
 * head holds `origin/dev` and has no green `e2e` check run, the pre-push
 * gate's own predicate, gets the `e2e` label, taken off first when it is on,
 * and waits for the run it starts; a head that does not hold it is rebased
 * first, as `dev` would only take a new commit. Then, in the checkout holding
 * the branch, refused before each rebase and each push unless it is still
 * clean at the head the landing left there: fetch, rebase on `origin/dev`,
 * refuse a rebased branch whose patch no verdict holds any more when it
 * touches a risky path. Then install the lockfile when
 * the rebase changed it, push the branch with a lease on the head last
 * pushed, push it to `dev`. A rebase that makes a new commit on a branch
 * touching the e2e paths waits again for that commit's runs and its own e2e
 * run. A `dev` push rejected because `origin/dev` moved starts over from the
 * fetch, three attempts at most. The pre-push hook runs the gates and the e2e
 * gate on every push, as for a push by hand. Once on `dev`, the branch is
 * deleted from origin, under a lease on the head that landed, when GitHub
 * reads its pull request merged within a minute and no open pull request is
 * based on it; its local branch and checkout stay, and a remote branch kept
 * is named, with why, on the verdict line of a landing that still succeeded.
 *
 * A stack lands from the checkout holding its top branch, the layers under it
 * read on origin, never moved locally. Each layer, bottom to top, must pass
 * the checks before any wait against its own base, and the top must hold
 * `origin/dev`: a stack is never rebased here, `gh stack rebase` and
 * `gh stack push` do that. One wait: a `workflow_dispatch` run of `ci.yml` on
 * the top's head, every job and `e2e` included, one dispatched when the head
 * has none; one already there is waited for, re-run once when red in its e2e
 * jobs alone, as a pull request's run is. Then one atomic push moves `dev` to the top
 * and each lower branch to it under a lease on the head it was read at, so
 * GitHub reads every pull request merged; a refusal moves nothing. A pull
 * request still open a minute later is named and no branch is deleted.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { isErrno, messageOf } from "../tools/platform/pure.ts";
import { LABEL as RED_DEV } from "./ci/red-dev.ts";
import {
  type CheckRun,
  checkRunsOf,
  isE2eCheck,
  isE2ePath,
  refusalFor,
} from "./gates/check-e2e-green.ts";
import { ROLLING_BRANCH, worktreePath } from "./headless/claude-code-types.ts";
import { probeSigning, runState } from "./headless/headless-run.ts";
import {
  type CiOutcome,
  type CiQuery,
  type CiRun,
  type Clock,
  ciVerdict,
  dispatchRun,
  type Gh,
  ghCli,
  REGISTRATION_MS,
  SYSTEM_CLOCK,
  waitFor,
} from "./landing/ci-wait.ts";
import {
  HOLDER_ENV,
  landingDir,
  lockPaths,
  repositoryOf,
  withLandingLock,
} from "./landing/landing-lock.ts";
import {
  BASE,
  baseRefOf,
  type Comment,
  DEV,
  REMOTE,
  patchIdOf,
  recordCommand,
  short,
  verdictsOf,
} from "./landing/review-verdict.ts";
import { type Layer, layerNumber, resolveTarget, type Target } from "./landing/stack.ts";
import { riskyOf, riskyPaths, type Tier, type Verdict } from "./landing/tier-floor.ts";
import { runWorkerOnce, type WorkerDeps } from "./landing/worker.ts";
import { run } from "./lib/run.ts";

/** Set in the environment of `origin/dev`'s copy, which runs the landing itself. */
const DEV_COPY = "LAND_DEV_COPY";

/** Set in the environment of `origin/dev`'s copy: the directory the landing was asked from. */
const LAND_CWD = "LAND_CWD";

const LANDABLE = /^(?:feature|fix|renovate)\/[\w./-]+$/u;

const LANDABLE_NAMES = `feature/, fix/ or renovate/ branch, or ${ROLLING_BRANCH}`;

const ATTEMPTS = 3;

const LOCKFILES = ["package.json", "bun.lock"];

const MOVED = /\[rejected\][^\n]*\((?:fetch first|non-fast-forward)\)/u;

const E2E_LABEL = "e2e";

const GREEN_JOB = new Set(["success", "skipped", "neutral"]);

const PR_NUMBER = /^\d+$/u;

/** `land.ts <n>` or `land.ts #<n>`: a pull request or a stack. */
const NUMBER_TARGET = /^#?(\d+)$/u;

/** The branches a pull request based on another branch can have, as a layer of a stack. */
const LAYER_BRANCH = /^(?:feature|fix)\//u;

/** The gh calls that write to GitHub, which `--dry-run` refuses to make. */
const GH_WRITES =
  /^(?:pr (?:edit|comment|create|merge|close|ready)|label create|run rerun|workflow run|issue (?:edit|comment|create|close))\b/u;

const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** Renovate's branches: `scripts/headless/renovate-agent.ts` and the verdict it posts guard them, not the tier. */
const BOT_BRANCH = /^renovate\//u;

/** The human's ok on one pull request, added only on the human's own words (`profile.approvals.labels`). */
export const LAND_OK = "land-ok";

export const TIER_LABELS: Readonly<
  Record<Tier, { readonly name: string; readonly color: string; readonly description: string }>
> = {
  low: { name: "tier:low", color: "0E8A16", description: "Lands on green checks without a human" },
  human: { name: "tier:human", color: "D93F0B", description: "Waits for the human's /land N" },
};

const TIER_LINE = /^(low|human) (.+)$/u;

/** A commit's oid, not git's zero oid, which is the `after` of a branch's deletion. */
const COMMIT = /^(?!0+$)[0-9a-f]{40,64}$/u;

/** The tier of the change from `base` to `head` in `checkout`, the pull request `pr`'s. */
export type Tiering = (
  checkout: string,
  pr: number,
  base: string,
  head: string,
) => Promise<Verdict>;

export interface Deps {
  readonly tier: Tiering;
}

export interface Waiting {
  readonly clock: Clock;
  readonly pollMs: number;
  /** The whole landing's, every wait in it included. */
  readonly timeoutMs: number;
}

export const WAITING: Waiting = { clock: SYSTEM_CLOCK, pollMs: 15_000, timeoutMs: 60 * 60_000 };

export interface PullRequest {
  readonly number: number;
  readonly state: string;
  readonly baseRefName: string;
  readonly headRefOid: string;
  readonly url: string;
  readonly labels: readonly { readonly name: string }[];
  readonly comments: readonly Comment[];
}

export type RemoteBranch =
  | { readonly kind: "deleted" }
  | { readonly kind: "kept"; readonly why: string };

export type Landing =
  | {
      readonly kind: "landed";
      readonly dev: string;
      readonly pr: number;
      readonly remote: RemoteBranch;
    }
  | {
      readonly kind: "landedStack";
      readonly dev: string;
      readonly stack: number | null;
      readonly layers: readonly {
        readonly number: number;
        readonly branch: string;
        readonly remote: RemoteBranch;
      }[];
    }
  | { readonly kind: "planned"; readonly lines: readonly string[] }
  | { readonly kind: "refused"; readonly why: string };

type Refused = Extract<Landing, { readonly kind: "refused" }>;

type Ready = { readonly kind: "ready"; readonly pr: PullRequest } | Refused;

/** What one landing carries through its waits. */
interface Lander {
  readonly branch: string;
  /** The branch its pull request must be open against: `dev`, or the layer under it in a stack. */
  readonly base: string;
  /** A `--dry-run`: GitHub is read, never written, and the tier comes from the pull request's label. */
  readonly readOnly: boolean;
  readonly checkout: string;
  readonly gh: Gh;
  readonly waiting: Waiting;
  readonly deadline: number;
  /** The runs this landing re-ran, each once at most. */
  readonly rerun: Set<number>;
  /** The head the landing started from, whose patch a `land-ok` must have been given to. */
  readonly reviewed: string;
  /** The number the human's `/land` names to land every layer this landing holds; null for one pull request, its own. */
  readonly landsAs: number | null;
  /** How the branch is tiered, its verdict once read; null for a branch with guards of its own. */
  readonly tiering: { readonly of: Tiering; verdict: Verdict | null } | null;
}

function refused(why: string): Refused {
  return { kind: "refused", why };
}

function headOf(checkout: string): string | null {
  const head = run(["git", "rev-parse", "HEAD"], checkout);

  return head.ok && head.out !== "" ? head.out : null;
}

function fetchOrigin(checkout: string): string | null {
  const fetched = run(["git", "fetch", "--quiet", REMOTE], checkout);

  return fetched.ok ? null : `git fetch: ${fetched.err}`;
}

function dirtyOf(checkout: string): string | null {
  const status = run(["git", "status", "--porcelain", "--untracked-files=no"], checkout);

  if (!status.ok) return `git status in ${checkout}: ${status.err}`;

  return status.out === ""
    ? null
    : `${checkout} has uncommitted changes: commit or drop them, then land`;
}

/**
 * Why the checkout no longer holds `head` clean, as this landing left it. A commit or an edit made while it waited
 * would land unreviewed, so it is refused and left as it is, never reset.
 */
function driftFrom(lander: Lander, head: string): string | null {
  const dirty = dirtyOf(lander.checkout);

  if (dirty !== null) return dirty;

  const now = headOf(lander.checkout);

  if (now === null) return `git rev-parse HEAD failed in ${lander.checkout}`;

  if (now === head) return null;

  return `${lander.branch} moved from ${short(head)} to ${short(now)} in ${lander.checkout} while land ran: push it, have it reviewed, then land again`;
}

/** The checkout that holds `branch`, read from `git worktree list --porcelain`. */
export function checkoutOf(porcelain: string, branch: string): string | null {
  for (const block of porcelain.split("\n\n")) {
    const lines = block.split("\n");
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);

    if (path !== undefined && lines.includes(`branch refs/heads/${branch}`)) return path;
  }

  return null;
}

/** Whether `a` and `b` spell one path: on Windows git prints `C:/x` where `resolve` gives `C:\x`. */
export function samePath(a: string, b: string, resolvePath = resolve): boolean {
  return resolvePath(a) === resolvePath(b);
}

/**
 * Why a branch may not land through `pr`, whatever its head and its runs; null when it may. `base` is the branch it
 * must be open against: `dev`, or the layer under it in a stack.
 */
export function refusalOf(pr: PullRequest, base: string): string | null {
  const name = `#${pr.number}`;

  if (pr.state !== "OPEN") return `${name} is ${pr.state.toLowerCase()}, not open`;

  if (pr.baseRefName !== base) {
    return `${name} targets ${pr.baseRefName}, not ${base}: land it by its number, bun ./scripts/land.ts ${pr.number}, which lands the pull requests under it too`;
  }

  return null;
}

/** Whether a push failed because the remote branch moved, as opposed to a hook or a rule. */
export function movedOn(pushError: string): boolean {
  return MOVED.test(pushError);
}

export type PathsRead =
  | { readonly kind: "read"; readonly paths: readonly string[] }
  | { readonly kind: "failed"; readonly why: string };

/** The paths `head` changes since its merge-base with `base`, a rename as both its sides. */
export function changedPaths(checkout: string, base: string, head = "HEAD"): PathsRead {
  const range = `${base}...${head}`;
  const diff = run(["git", "diff", "--name-only", "--no-renames", "-z", range], checkout);

  if (!diff.ok) return { kind: "failed", why: `git diff ${range}: ${diff.err}` };

  return { kind: "read", paths: diff.out.split("\0").filter((path) => path !== "") };
}

/**
 * Why the branch, `reviewed` on its pull request and `rebased` here, changing `paths`, may not land without another
 * review; null when it touches no risky path or a clean verdict holds its patch against the pull request's base. The
 * risky paths are read from `origin/dev`, never the checkout, so a branch cannot loosen the rule it lands under;
 * while that profile does not read, every path is risky, and a verdict still lands the branch that repairs it.
 */
function reviewRefusal(
  branch: string,
  pr: PullRequest,
  checkout: string,
  { reviewed, rebased, paths }: { reviewed: string; rebased: string; paths: readonly string[] },
): string | null {
  const profile = riskyOf(checkout, BASE);
  const touched = riskyPaths(paths, profile);

  if (touched.length === 0) return null;

  const base = baseRefOf(pr);
  const landing = patchIdOf(checkout, base, rebased);

  if (landing.kind === "failed") return landing.why;

  const verdicts = verdictsOf(pr.comments);

  if (verdicts.has(landing.id)) return null;

  const before = patchIdOf(checkout, base, reviewed);

  if (before.kind === "read" && verdicts.has(before.id)) {
    return `the rebase on ${BASE} changed the diff of ${branch} since its review (patch-id ${short(before.id)} reviewed, ${short(landing.id)} now): rebase it, push it, review it again, then ${recordCommand(branch, "<the head you reviewed>")}, and land again`;
  }

  const risky =
    profile.kind === "unreadable"
      ? `${profile.why}; until it reads, every path counts as risky, and ${branch} changes ${touched.join(", ")}`
      : `${branch} touches risky paths (${touched.join(", ")})`;

  return `${risky}; #${pr.number} carries no clean review verdict for its change, patch-id ${short(landing.id)}: review ${short(reviewed)}, and once no finding is open, ${recordCommand(branch, reviewed)}; then land again`;
}

async function readPullRequest({
  gh,
  branch,
}: Pick<Lander, "gh" | "branch">): Promise<PullRequest> {
  const out = await gh([
    "pr",
    "view",
    branch,
    "--json",
    "number,state,baseRefName,headRefOid,url,labels,comments",
  ]);

  try {
    // SAFETY: gh prints exactly the fields asked for, and a pull request with a field missing can only fail to read
    // as open, against dev and at the head waited for, or fail before any write when its url is read.
    return JSON.parse(out);
  } catch {
    throw new Error(`gh printed no pull request for ${branch}: ${out.trim()}`);
  }
}

/**
 * `tier.ts` beside this script, `origin/dev`'s when this runs as its copy, reading `checkout`. It starts in its own
 * directory, not the checkout: bun runs the `preload` of the `bunfig.toml` it starts in, which the branch could set.
 */
export async function tierScript(
  checkout: string,
  pr: number,
  base: string,
  head: string,
): Promise<Verdict> {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "landing", "tier.ts"),
      "--pr",
      String(pr),
      "--base",
      base,
      "--head",
      head,
      "--checkout",
      checkout,
    ],
    // Without `env`, Bun hands the child the environment this process started with, not process.env as it is now.
    { cwd: import.meta.dir, env: process.env, stdout: "pipe", stderr: "pipe" },
  );

  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  const line = TIER_LINE.exec(out.trim());

  if (code === 0 && line !== null) {
    return { tier: line[1] === "low" ? "low" : "human", reason: line[2] ?? "" };
  }

  const [first = ""] = (err || out).trim().split("\n");

  return { tier: "human", reason: `tier.ts exited ${code}: ${first}` };
}

export const DEPS: Deps = { tier: tierScript };

interface Label {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

const LAND_OK_LABEL: Label = {
  name: LAND_OK,
  color: "5319E7",
  description: "The human typed /land N in a session",
};

/** Creates `label` in the repository, or sets its color and description when it exists. */
async function createLabel(lander: Lander, { name, color, description }: Label): Promise<void> {
  await lander.gh([
    "label",
    "create",
    name,
    "--force",
    "--color",
    color,
    "--description",
    description,
  ]);
}

/** Puts the label of `tier` on the pull request, taking `tier:low` off a human one: a tier only goes up. */
async function labelTier(lander: Lander, labels: ReadonlySet<string>, tier: Tier): Promise<void> {
  const { name } = TIER_LABELS[tier];
  const low = TIER_LABELS.low.name;

  if (tier === "human" && labels.has(low)) {
    await lander.gh(["pr", "edit", lander.branch, "--remove-label", low]);
  }

  if (labels.has(name)) return;

  await createLabel(lander, TIER_LABELS[tier]);
  await lander.gh(["pr", "edit", lander.branch, "--add-label", name]);
}

/**
 * The branch's head on GitHub when `added`: the last push GitHub lists before that time. Read from the server's push
 * times, not a commit's date, which its author sets.
 */
async function headPushedBefore(
  read: Pick<Lander, "gh" | "branch">,
  added: string,
): Promise<string | null> {
  const before = Date.parse(added);
  let last: Push | null = null;

  for (const push of await pushesOf(read)) {
    if (push.at < before && COMMIT.test(push.after) && (last === null || push.at > last.at)) {
      last = push;
    }
  }

  return last?.after ?? null;
}

interface Push {
  readonly at: number;
  readonly before: string;
  readonly after: string;
}

/** The pushes to the branch GitHub lists, each with its time and the heads it moved the branch from and to. */
async function pushesOf({ gh, branch }: Pick<Lander, "gh" | "branch">): Promise<readonly Push[]> {
  const out = await gh([
    "api",
    `repos/{owner}/{repo}/activity?ref=refs/heads/${branch}&per_page=100`,
    "--paginate",
    "--jq",
    '.[] | "\\(.timestamp) \\(.before) \\(.after)"',
  ]);

  return out.split("\n").flatMap((line) => {
    const [timestamp = "", before = "", after = ""] = line.split(" ");
    const at = Date.parse(timestamp);

    return Number.isFinite(at) ? [{ at, before, after }] : [];
  });
}

/** Why `sha` is neither here nor fetched from origin, or null once it is here. */
function unserved(checkout: string, sha: string): string | null {
  if (run(["git", "cat-file", "-e", `${sha}^{commit}`], checkout).ok) return null;

  const fetched = run(["git", "fetch", "--quiet", REMOTE, sha], checkout);

  return fetched.ok ? null : `which ${REMOTE} no longer serves: ${fetched.err.trim()}`;
}

/**
 * Null when the pull request carries a `land-ok` given to the change that lands: the head GitHub held when the label
 * was added has the patch of the head this landing started from. A rebase that keeps the patch, `land.ts`'s own
 * included, keeps the ok; a commit after it does not, and that ok comes off (`voidApproval`). The patch is read
 * against the pull request's base: for a layer of a stack, the ok's against the base's head GitHub held when the
 * label was added, so a cascade that keeps every layer's patch keeps it too. An ok whose head or patch cannot be read
 * is refused as it is: nothing is taken off on a read that failed.
 */
async function approvalOf(
  lander: Lander,
  pr: PullRequest,
  labels: ReadonlySet<string>,
): Promise<string | null> {
  if (!labels.has(LAND_OK)) return `with no ${LAND_OK} label`;

  const events = await lander.gh([
    "api",
    `repos/{owner}/{repo}/issues/${pr.number}/events`,
    "--paginate",
    "--jq",
    `.[] | select(.event == "labeled" and .label.name == "${LAND_OK}") | .created_at`,
  ]);

  const added = events
    .split("\n")
    .filter((line) => line !== "")
    .at(-1);

  if (added === undefined) return `with a ${LAND_OK} label GitHub lists no event of`;

  const approved = await headPushedBefore(lander, added);

  if (approved === null) {
    return `with a ${LAND_OK} added at ${added}, before any push of ${lander.branch} GitHub lists`;
  }

  if (approved === lander.reviewed && pr.baseRefName === DEV) return null;

  const given = `with a ${LAND_OK} given to ${short(approved)}`;
  const missing = unserved(lander.checkout, approved);

  if (missing !== null) return `${given}, ${missing}`;

  let baseThen = baseRefOf(pr);

  if (pr.baseRefName !== DEV) {
    const held = await headPushedBefore({ gh: lander.gh, branch: pr.baseRefName }, added);

    if (held === null) {
      return `${given}, before any push of its base ${pr.baseRefName} GitHub lists`;
    }

    const baseMissing = unserved(lander.checkout, held);

    if (baseMissing !== null)
      return `${given} on ${pr.baseRefName} at ${short(held)}, ${baseMissing}`;

    // The same head over a base rewound or rewritten since carries a patch the ok never covered.
    const baseNow = run(
      ["git", "rev-parse", "--verify", "--quiet", `${baseRefOf(pr)}^{commit}`],
      lander.checkout,
    ).out;

    if (approved === lander.reviewed && held === baseNow) return null;

    baseThen = held;
  }

  const then = patchIdOf(lander.checkout, baseThen, approved);

  if (then.kind === "failed") return `${given}, whose patch does not read: ${then.why}`;

  const now = patchIdOf(lander.checkout, baseRefOf(pr), lander.reviewed);

  if (now.kind === "failed") return `${given}, and a head whose patch does not read: ${now.why}`;

  if (then.id === now.id) return null;

  return voidApproval(lander, pr, approved, baseThen);
}

interface PatchedCommit {
  readonly sha: string;
  readonly subject: string;
  /** Its `git patch-id --stable`; undefined for a commit that changes nothing. */
  readonly patch: string | undefined;
}

/** The commits `base..head` holds, merges aside, newest first, each with its patch-id. */
function patchedCommits(checkout: string, base: string, head: string): readonly PatchedCommit[] {
  const range = `${base}..${head}`;
  const listed = run(["git", "log", "--no-merges", "--format=%H%x00%s", range], checkout);

  const patches = run(
    [
      "git",
      "log",
      "-p",
      "--no-merges",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--format=commit %H",
      range,
    ],
    checkout,
  );

  if (!listed.ok || !patches.ok) {
    throw new Error(`git log ${range}: ${(listed.ok ? patches.err : listed.err).trim()}`);
  }

  const ids = run(["git", "patch-id", "--stable"], checkout, patches.raw);

  if (!ids.ok) throw new Error(`git patch-id of ${range}: ${ids.err.trim()}`);

  const patchOf = new Map(
    ids.out
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [patch = "", sha = ""] = line.split(" ");

        return [sha, patch] as const;
      }),
  );

  return listed.out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [sha = "", subject = ""] = line.split("\0");

      return { sha, subject, patch: patchOf.get(sha) };
    });
}

/**
 * Takes off a `land-ok` whose change is no longer the pull request's: the human's next `/land <n>` adds it again,
 * as a new event GitHub dates, which a label left on would not be. The comment, posted first so a failed removal
 * loses nothing, leaves the human what to read before that: the commits of the change now, from the base to the
 * head, with no patch among those of the change the ok covered, from `baseThen` to its head, each linked, so a
 * rebase brings none in and a base rewound under the head names what it let in; and GitHub's compare view of the
 * two heads when the ok's head leads to this one over the same base, since otherwise that view shows the rebase too
 * or nothing at all.
 */
async function voidApproval(
  lander: Lander,
  pr: PullRequest,
  approved: string,
  baseThen: string,
): Promise<string> {
  const { branch, checkout, reviewed } = lander;
  const covered = new Set(patchedCommits(checkout, baseThen, approved).map(({ patch }) => patch));
  const repo = pr.url.replace(/\/pull\/\d+$/u, "");

  const commits = patchedCommits(checkout, baseRefOf(pr), reviewed).flatMap(
    ({ sha, subject, patch }) =>
      patch === undefined || covered.has(patch)
        ? []
        : [`- ${short(sha)} ${subject} (${repo}/commit/${sha})`],
  );

  const sameBase =
    pr.baseRefName === DEV ||
    run(["git", "rev-parse", "--verify", "--quiet", `${baseRefOf(pr)}^{commit}`], checkout).out ===
      baseThen;

  const linear =
    sameBase &&
    approved !== reviewed &&
    run(["git", "merge-base", "--is-ancestor", approved, reviewed], checkout).ok;

  const compare = `${repo}/compare/${approved}...${reviewed}`;
  // Two dots: the two heads' trees compared as they are, for a change with no commit to list.
  const direct = `${repo}/compare/${approved}..${reviewed}`;

  const changed =
    commits.length === 0
      ? "the patch changed with no new commit, amended or reset"
      : `${commits.length === 1 ? "1 commit" : `${commits.length} commits`} since changed the patch`;

  const toRead = linear
    ? compare
    : commits.length === 0
      ? `the two heads' own diff, ${direct}`
      : approved === reviewed
        ? "the commits below"
        : `the commits below; the compare view ${compare} would show the rebase too`;

  const where = linear ? compare : commits.length === 0 ? direct : "the commits its comment links";

  if (lander.readOnly) {
    return `with a ${LAND_OK} given to ${short(approved)}, whose change is not that of its head ${short(reviewed)}: land.ts would take the label off; to read at ${where}`;
  }

  await lander.gh([
    "pr",
    "comment",
    branch,
    "--body",
    [
      `<!-- land-ok: void approved=${approved} head=${reviewed} -->`,
      `The human's \`${LAND_OK}\` covered ${short(approved)}; ${changed}, so the label is off. To read before the next /land ${lander.landsAs ?? pr.number}: ${toRead}`,
      ...commits,
    ].join("\n"),
  ]);
  await lander.gh(["pr", "edit", branch, "--remove-label", LAND_OK]);

  return `with a ${LAND_OK} given to ${short(approved)}, whose change is not that of its head ${short(reviewed)}: the label is off; ${commits.length === 0 ? "no new commit, the patch amended or reset" : `${commits.length === 1 ? "1 commit" : `${commits.length} commits`} since`}, to read at ${where}`;
}

/** The open `red-dev` issues, each `#<number>`. */
async function redDevIssues(lander: Lander): Promise<readonly string[]> {
  const out = await lander.gh([
    "issue",
    "list",
    "--label",
    RED_DEV,
    "--state",
    "open",
    "--json",
    "number",
    "--jq",
    ".[].number",
  ]);

  return out
    .split("\n")
    .filter((line) => line !== "")
    .map((number) => `#${number}`);
}

/** The tier a `--dry-run` reads from the pull request's labels, never asking the judge. */
function labelledTier(labels: ReadonlySet<string>): Verdict {
  if (labels.has(TIER_LABELS.low.name)) return { tier: "low", reason: "its tier:low label" };

  return labels.has(TIER_LABELS.human.name)
    ? { tier: "human", reason: "its tier:human label" }
    : { tier: "human", reason: "no tier label, not judged in a dry run" };
}

/**
 * What holds `pr` back at its tier: a human one waiting for the human's `/land`, `awaits` its tier and what it lacks,
 * or a low one while `dev` is red.
 */
type TierHold =
  | { readonly kind: "awaits-land"; readonly why: string; readonly awaits: string }
  | { readonly kind: "red-dev"; readonly why: string };

/**
 * Why `pr` may not land at its tier, or null when it may: a human one without a `land-ok` given to its change, a low
 * one without it while `dev` is red. The tier is the branch's, read once per landing, raised by a `tier:human` label
 * an earlier pass left; its label goes on the pull request on the way, and a `land-ok` given to another change
 * comes off on the way too, named in the refusal.
 */
async function tierRefusal(lander: Lander, pr: PullRequest): Promise<TierHold | null> {
  const { tiering } = lander;

  if (tiering === null) return null;

  const labels = new Set(pr.labels.map((label) => label.name));

  tiering.verdict ??= lander.readOnly
    ? labelledTier(labels)
    : await tiering.of(lander.checkout, pr.number, baseRefOf(pr), lander.reviewed);

  const raised = tiering.verdict.tier === "low" && labels.has(TIER_LABELS.human.name);
  const tier: Tier = raised ? "human" : tiering.verdict.tier;

  if (!lander.readOnly) await labelTier(lander, labels, tier);

  if (tier === "human") {
    const approval = await approvalOf(lander, pr, labels);

    if (approval === null) return null;

    // The human's next /land puts land-ok on, outside any shift pass that would create the label.
    if (!labels.has(LAND_OK) && !lander.readOnly) await createLabel(lander, LAND_OK_LABEL);

    const why = raised
      ? `its tier:human label, left by an earlier pass; tier.ts now says low: ${tiering.verdict.reason}`
      : tiering.verdict.reason;

    const lacks = `${approval}: it lands once the human types /land ${lander.landsAs ?? pr.number} in a session`;

    return {
      kind: "awaits-land",
      why: `#${pr.number} is tier:human (${why}), ${lacks}; stop`,
      awaits: `tier human (${why}), ${lacks}`,
    };
  }

  const red = await redDevIssues(lander);

  if (red.length === 0) return null;

  const approval = await approvalOf(lander, pr, labels);

  if (approval === null) return null;

  const unattended = `${DEV} is red (${red.join(", ")}): no unattended landing until it is green`;

  return {
    kind: "red-dev",
    why: labels.has(LAND_OK) ? `${unattended}; #${pr.number}, ${approval}` : unattended,
  };
}

function remaining(lander: Lander): number {
  return Math.max(0, lander.deadline - lander.waiting.clock.now());
}

/**
 * `lander` with a minute of its own once its push to `dev` went through: GitHub reads the push within seconds,
 * whatever the landing's hour has left, and a wait that used that hour up must not read the pull request just once.
 */
function afterPush(lander: Lander): Lander {
  return { ...lander, deadline: lander.waiting.clock.now() + REGISTRATION_MS };
}

/** What `read` gives once `done` holds of it, or its last read once a minute, or the landing's time, runs out. */
async function pollUntil<T>(
  lander: Lander,
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  const { clock, pollMs } = lander.waiting;
  const windowMs = Math.min(REGISTRATION_MS, remaining(lander));
  const start = clock.now();
  let value = await read();

  while (!done(value) && clock.now() - start < windowMs) {
    await clock.sleep(Math.min(pollMs, windowMs - (clock.now() - start)));
    value = await read();
  }

  return value;
}

/** The pull request once GitHub shows `sha` as its head: a push takes a moment to reach it. */
async function pullRequestAt(lander: Lander, sha: string): Promise<Ready> {
  const pr = await pollUntil(
    lander,
    () => readPullRequest(lander),
    (read) => read.headRefOid === sha || refusalOf(read, lander.base) !== null,
  );

  const refusal = refusalOf(pr, lander.base);

  if (refusal !== null) return refused(refusal);

  if (pr.headRefOid !== sha) {
    return refused(
      `${lander.branch} is at ${short(sha)} here and ${short(pr.headRefOid)} on #${pr.number}: push it, then land again`,
    );
  }

  return { kind: "ready", pr };
}

/** The jobs of `run`, at any attempt, that ended neither green nor skipped, read from its commit's check runs. */
function failedJobs(checks: readonly CheckRun[], ciRun: CiRun): readonly string[] {
  return checks.flatMap((check) =>
    check.detailsUrl?.includes(`/actions/runs/${ciRun.id}/job/`) === true &&
    check.status === "completed" &&
    !GREEN_JOB.has(check.conclusion ?? "")
      ? [check.name]
      : [],
  );
}

/** The outcome of the runs `query` reads, each run red in its e2e jobs alone re-run once first. */
async function settle(lander: Lander, query: CiQuery): Promise<CiOutcome> {
  const { clock, pollMs } = lander.waiting;
  const outcome = await waitFor(lander.gh, query, { timeoutMs: remaining(lander), pollMs }, clock);

  if (outcome.kind !== "red") return outcome;

  const checks = checkRunsOf(query.sha, lander.checkout);

  if (checks.kind === "unreadable") return outcome;

  const rerunnable = outcome.red.filter((red) => {
    const failed = failedJobs(checks.runs, red);

    return (
      !lander.rerun.has(red.id) && failed.length > 0 && failed.every((name) => isE2eCheck(name))
    );
  });

  if (rerunnable.length < outcome.red.length) return outcome;

  await Promise.all(
    rerunnable.map((red) => lander.gh(["run", "rerun", String(red.id), "--failed"])),
  );

  const ids = new Set(rerunnable.map((red) => red.id));

  for (const id of ids) lander.rerun.add(id);

  await pollUntil(
    lander,
    () => ciVerdict(lander.gh, query),
    (verdict) => verdict.kind !== "red" || !verdict.red.some((red) => ids.has(red.id)),
  );

  return settle(lander, query);
}

function notGreen(
  lander: Lander,
  pr: Pick<PullRequest, "number">,
  sha: string,
  outcome: Exclude<CiOutcome, { readonly kind: "green" }>,
): string {
  switch (outcome.kind) {
    case "red": {
      const runs = outcome.red.map((red) =>
        lander.rerun.has(red.id) ? `${red.url}, red again after the re-run land made` : red.url,
      );

      return `CI is red on ${short(sha)}, the head of #${pr.number}: ${runs.join("; ")}. Fix it and push, or re-run a flake with gh run rerun <run-id> --failed; then land again`;
    }

    case "none":
      return `no ci.yml run showed on ${short(sha)}, the head of #${pr.number}, within a minute: land again once one runs`;

    case "timeout":
      return `CI still runs on ${short(sha)}, the head of #${pr.number}, after the ${lander.waiting.timeoutMs / 60_000} min land waits at most: ${outcome.running.map((running) => running.url).join("; ")}; land again`;
  }
}

/**
 * Starts an e2e run on `query.sha` with the label and waits for it, told from the `seen` runs: why it ends without a
 * green `e2e` check run, or null.
 */
async function requestE2e(
  lander: Lander,
  query: CiQuery,
  seen: readonly CiRun[],
): Promise<string | null> {
  const pr = await readPullRequest(lander);

  // Adding a label the pull request already carries starts no run.
  if (pr.labels.some((label) => label.name === E2E_LABEL)) {
    await lander.gh(["pr", "edit", lander.branch, "--remove-label", E2E_LABEL]);
  }

  await lander.gh(["pr", "edit", lander.branch, "--add-label", E2E_LABEL]);

  const outcome = await settle(lander, { ...query, known: seen.map((seenRun) => seenRun.id) });

  if (outcome.kind === "none") {
    return `the ${E2E_LABEL} label added to #${pr.number} started no run on ${short(query.sha)} within a minute: land again`;
  }

  if (outcome.kind !== "green") return notGreen(lander, pr, query.sha, outcome);

  const after = refusalFor(checkRunsOf(query.sha, lander.checkout));

  return after === null
    ? null
    : `the run the ${E2E_LABEL} label started on ${short(query.sha)} ended green, yet ${after.reason}: land again`;
}

/**
 * The pull request once every `ci.yml` run of `sha`, its head, is green and, for a branch touching the e2e paths,
 * one `e2e` check run of it is, as the pre-push gate asks; read again then, with the comments posted meanwhile.
 */
async function ready(lander: Lander, sha: string, e2e: boolean): Promise<Ready> {
  const at = await pullRequestAt(lander, sha);

  if (at.kind === "refused") return at;

  // Read again after the wait for the lock, which can outlast a land-ok or a green dev.
  const before = await tierRefusal(lander, at.pr);

  if (before !== null) return refused(before.why);

  const query: CiQuery = { sha, event: "pull_request" };
  const outcome = await settle(lander, query);

  if (outcome.kind !== "green") return refused(notGreen(lander, at.pr, sha, outcome));

  if (e2e) {
    const checks = checkRunsOf(sha, lander.checkout);

    if (checks.kind === "unreadable") {
      return refused(`gh could not list the check runs of ${short(sha)}: ${checks.error}`);
    }

    if (refusalFor(checks) !== null) {
      const requested = await requestE2e(lander, query, outcome.runs);

      if (requested !== null) return refused(requested);
    }
  }

  const after = await pullRequestAt(lander, sha);

  if (after.kind === "refused") return after;

  const tiered = await tierRefusal(lander, after.pr);

  return tiered === null ? after : refused(tiered.why);
}

function kept(why: string): RemoteBranch {
  return { kind: "kept", why: why.replaceAll(/\s*\n\s*/gu, " ") };
}

async function stateOf(lander: Lander, pr: number): Promise<string> {
  const out = await lander.gh(["pr", "view", String(pr), "--json", "state"]);

  try {
    // SAFETY: gh prints the field asked for, and a state that does not read as MERGED keeps the branch.
    const { state }: { readonly state: string } = JSON.parse(out);

    return state;
  } catch {
    throw new Error(`gh printed no state for #${pr}: ${out.trim()}`);
  }
}

/** The open pull requests based on the branch, each `#<number>`: GitHub closes them when it goes. */
async function stackedOn(lander: Lander): Promise<readonly string[]> {
  const out = await lander.gh([
    "pr",
    "list",
    "--base",
    lander.branch,
    "--state",
    "open",
    "--json",
    "number",
    "--jq",
    ".[].number",
  ]);

  const numbers = out.split("\n").filter((line) => line !== "");
  const unread = numbers.find((line) => !PR_NUMBER.test(line));

  if (unread !== undefined) {
    throw new Error(
      `gh listed a pull request based on ${lander.branch} that does not read as a number: ${JSON.stringify(unread)}`,
    );
  }

  return numbers.map((number) => `#${number}`);
}

/**
 * Deletes the branch that landed at `head` through `pr` from origin, the local branch and its checkout left where the
 * agent works. GitHub sees the push to dev a moment later: deleted before it reads `pr` merged, the branch would leave
 * `pr` closed, not merged.
 */
async function deleteRemote(lander: Lander, pr: number, head: string): Promise<RemoteBranch> {
  try {
    const state = await pollUntil(
      lander,
      () => stateOf(lander, pr),
      (read) => read !== "OPEN",
    );

    if (state !== "MERGED") {
      return kept(
        `#${pr} reads ${state.toLowerCase()} on GitHub, not merged: deleting ${lander.branch} now would close it unmerged`,
      );
    }

    const stacked = await stackedOn(lander);

    if (stacked.length > 0) {
      return kept(`${stacked.join(", ")} open on ${lander.branch} would close with it`);
    }
  } catch (error) {
    return kept(messageOf(error));
  }

  const ref = `refs/heads/${lander.branch}`;

  const deleted = run(
    ["git", "push", "--quiet", `--force-with-lease=${ref}:${head}`, REMOTE, "--delete", ref],
    lander.checkout,
  );

  return deleted.ok ? { kind: "deleted" } : kept(`the delete was refused: ${deleted.err}`);
}

/** Where a checkout of `branch` is added when none holds it: under the main worktree's `.claude/worktrees/`. */
export function addedCheckoutPath(porcelain: string, branch: string): string | null {
  const main = porcelain
    .split("\n")
    .find((line) => line.startsWith("worktree "))
    ?.slice("worktree ".length);

  return main === undefined
    ? null
    : join(main, ".claude", "worktrees", `land-${branch.replaceAll("/", "-")}`);
}

type Added = { readonly kind: "added"; readonly path: string } | Refused;

function removeCheckout(cwd: string, path: string): void {
  const removed = run(["git", "worktree", "remove", path], cwd);

  if (!removed.ok) console.error(`land: the checkout ${path} it added stays: ${removed.err}`);
}

/** A checkout of `branch` added for this landing, from its local branch or else from origin's, its lockfile installed. */
function addCheckout(cwd: string, porcelain: string, branch: string): Added {
  const path = addedCheckoutPath(porcelain, branch);

  if (path === null) return refused("git worktree list --porcelain named no main worktree");

  const unfetched = fetchOrigin(cwd);

  if (unfetched !== null) return refused(unfetched);

  const local = run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd).ok;
  const remote = `refs/remotes/${REMOTE}/${branch}`;

  if (!local && !run(["git", "rev-parse", "--verify", "--quiet", remote], cwd).ok) {
    return refused(
      `no checkout holds ${branch}, and ${REMOTE} has no ${branch}: push it, then land`,
    );
  }

  const added = run(
    local
      ? ["git", "worktree", "add", "--quiet", path, branch]
      : ["git", "worktree", "add", "--quiet", "--track", "-b", branch, path, `${REMOTE}/${branch}`],
    cwd,
  );

  if (!added.ok) return refused(`git worktree add ${path}: ${added.err}`);

  if (existsSync(join(path, "bun.lock"))) {
    const install = run(["bun", "install", "--frozen-lockfile"], path);

    if (!install.ok) {
      removeCheckout(cwd, path);

      return refused(`bun install --frozen-lockfile in ${path}: ${install.err}`);
    }
  }

  return { kind: "added", path };
}

/**
 * Brings a clean checkout to its pull request's head: fast-forwarded when behind it, as a worker's kept worktree is
 * once a `fix` worker pushed on it, reset when its head is one a push to GitHub already replaced, as after a `fix`
 * worker's rebase. A head GitHub never held is left for the landing to refuse. A dry run moves nothing: a checkout
 * apart from its pull request's head is refused.
 */
async function caughtUp(
  { gh, branch, readOnly }: Pick<Lander, "gh" | "branch" | "readOnly">,
  checkout: string,
): Promise<string | null> {
  const unfetched = fetchOrigin(checkout);

  if (unfetched !== null) return unfetched;

  const head = headOf(checkout);

  if (head === null) return `git rev-parse HEAD failed in ${checkout}`;

  const { headRefOid } = await readPullRequest({ gh, branch });

  if (headRefOid === head) return null;

  if (readOnly) {
    return `${checkout} is at ${short(head)} and the pull request of ${branch} at ${short(headRefOid)}: land.ts would bring it there first`;
  }

  if (run(["git", "merge-base", "--is-ancestor", head, headRefOid], checkout).ok) {
    const merged = run(["git", "merge", "--ff-only", "--quiet", headRefOid], checkout);

    return merged.ok
      ? null
      : `git merge --ff-only ${short(headRefOid)} in ${checkout}: ${merged.err}`;
  }

  // A head GitHub once held and a push moved away from, as a fix worker's rebase does, holds nothing unpushed.
  const superseded = (await pushesOf({ gh, branch })).some((push) => push.before === head);

  if (!superseded) return null;

  const reset = run(["git", "reset", "--quiet", "--hard", headRefOid], checkout);

  return reset.ok ? null : `git reset --hard ${short(headRefOid)} in ${checkout}: ${reset.err}`;
}

/** Whether `args` write to GitHub: a call `--dry-run` refuses to make. */
function writes(args: readonly string[]): boolean {
  const flag = args.findIndex((arg) => arg === "-X" || arg === "--method");
  const method = flag === -1 ? undefined : args[flag + 1]?.toUpperCase();

  return GH_WRITES.test(args.join(" ")) || (method !== undefined && WRITE_METHODS.has(method));
}

/** `gh` as `--dry-run` runs it: a call that would write to GitHub is refused, never made. */
function readOnlyGh(gh: Gh): Gh {
  return (args) =>
    writes(args)
      ? Promise.reject(new Error(`--dry-run: land.ts would run gh ${args.join(" ")}`))
      : gh(args);
}

/**
 * Lands `target`: a branch, or a number, the pull request it names with those under it, or the stack it names. A
 * branch whose pull request is based on another branch lands as the pull request it is.
 */
export async function land(
  target: string,
  cwd: string,
  waiting: Waiting = WAITING,
  deps: Deps = DEPS,
  dryRun = false,
): Promise<Landing> {
  const plain: Gh = (args) => ghCli(args, cwd);
  const gh = dryRun ? readOnlyGh(plain) : plain;
  let number = NUMBER_TARGET.exec(target)?.[1];

  if (number === undefined && LAYER_BRANCH.test(target) && LANDABLE.test(target)) {
    number = (await layerNumber(gh, target))?.toString();
  }

  if (number === undefined) return landBranch(target, cwd, waiting, deps, dryRun);

  let resolved: Target;

  try {
    resolved = await resolveTarget(gh, Number(number));
  } catch (error) {
    return refused(messageOf(error));
  }

  if (resolved.kind === "refused") return resolved;

  const [only, ...above] = resolved.layers;

  if (only !== undefined && above.length === 0) {
    return landBranch(only.branch, cwd, waiting, deps, dryRun);
  }

  return landStack(resolved.layers, resolved.stack, cwd, waiting, deps, dryRun);
}

async function landBranch(
  branch: string,
  cwd: string,
  waiting: Waiting,
  deps: Deps,
  dryRun: boolean,
): Promise<Landing> {
  if (!LANDABLE.test(branch) && branch !== ROLLING_BRANCH) {
    return refused(`${branch} is not a ${LANDABLE_NAMES}: only those land on ${DEV}`);
  }

  const worktrees = run(["git", "worktree", "list", "--porcelain"], cwd);

  if (!worktrees.ok) return refused(`git worktree list: ${worktrees.err}`);

  const held = checkoutOf(worktrees.out, branch);

  if (held === null && dryRun) return landFrom(branch, cwd, false, waiting, deps, true);

  if (held === null) {
    const added = addCheckout(cwd, worktrees.out, branch);

    if (added.kind === "refused") return added;

    try {
      return await landFrom(branch, added.path, true, waiting, deps, false);
    } finally {
      removeCheckout(cwd, added.path);
    }
  }

  if (branch === ROLLING_BRANCH && samePath(held, await worktreePath(cwd))) {
    return refused(
      `${held} is where the types run recreates its worktree, under a landing: move that checkout elsewhere (git worktree move ${held} <path>), then land`,
    );
  }

  return landFrom(branch, held, true, waiting, deps, dryRun);
}

/**
 * The head the landing starts from in `checkout`: the one it holds, brought to its pull request's head first, or, in
 * a dry run from a checkout that does not hold `branch`, the pull request's head as GitHub shows it.
 */
async function startingHead(
  read: Pick<Lander, "gh" | "branch" | "readOnly">,
  checkout: string,
  holds: boolean,
): Promise<{ readonly kind: "head"; readonly head: string } | Refused> {
  try {
    if (!holds) {
      const unfetched = fetchOrigin(checkout);

      if (unfetched !== null) return refused(unfetched);

      return { kind: "head", head: (await readPullRequest(read)).headRefOid };
    }

    const behind = await caughtUp(read, checkout);

    if (behind !== null) return refused(behind);
  } catch (error) {
    return refused(messageOf(error));
  }

  const head = headOf(checkout);

  return head === null
    ? refused(`git rev-parse HEAD failed in ${checkout}`)
    : { kind: "head", head };
}

/**
 * The landing of `branch` from `checkout`, the clean checkout that holds it; in a dry run, any checkout of the
 * repository, which `holds` says.
 */
async function landFrom(
  branch: string,
  checkout: string,
  holds: boolean,
  waiting: Waiting,
  deps: Deps,
  readOnly: boolean,
): Promise<Landing> {
  const dirty = holds ? dirtyOf(checkout) : null;

  if (dirty !== null) return refused(dirty);

  const plain: Gh = (args) => ghCli(args, checkout);
  const gh = readOnly ? readOnlyGh(plain) : plain;
  const start = await startingHead({ gh, branch, readOnly }, checkout, holds);

  if (start.kind === "refused") return start;

  const reviewed = start.head;
  const touched = changedPaths(checkout, BASE, reviewed);

  if (touched.kind === "failed") return refused(touched.why);

  const lander: Lander = {
    branch,
    base: DEV,
    readOnly,
    checkout,
    gh,
    waiting,
    deadline: waiting.clock.now() + waiting.timeoutMs,
    rerun: new Set(),
    reviewed,
    landsAs: null,
    tiering:
      BOT_BRANCH.test(branch) || branch === ROLLING_BRANCH
        ? null
        : { of: deps.tier, verdict: null },
  };

  const passed = await readyBeforeWait(lander);

  if (passed.kind === "refused") return passed;

  if (readOnly) return branchPlan(lander, passed);

  const url = run(["git", "remote", "get-url", "--push", REMOTE], checkout);

  if (!url.ok) return refused(`git remote get-url --push ${REMOTE}: ${url.err}`);

  // The hour the landing waits at most starts once it holds the lock.
  return withLandingLock(url.out, branch, waiting, () =>
    landLocked({ ...lander, deadline: waiting.clock.now() + waiting.timeoutMs }, touched.paths),
  );
}

type Checked =
  | {
      readonly kind: "ready";
      readonly pr: PullRequest;
      readonly paths: readonly string[];
      readonly awaits: string | null;
    }
  | Refused;

/**
 * The pull request and the paths it changes against its base, once the checks that come before any wait pass, so
 * that a landing the human or a review still holds back waits for nothing: the pull request at the head the landing
 * starts from, its tier, and the review verdict of a branch that touches a risky path. A dry run goes on past a
 * human tier that waits for the human's `/land`, which `awaits` names, so its plan shows every other check.
 */
async function readyBeforeWait(lander: Lander): Promise<Checked> {
  const { branch, checkout, reviewed } = lander;

  try {
    const at = await pullRequestAt(lander, reviewed);

    if (at.kind === "refused") return at;

    const tiered = await tierRefusal(lander, at.pr);

    if (tiered !== null && !(lander.readOnly && tiered.kind === "awaits-land")) {
      return refused(tiered.why);
    }

    const awaits = tiered?.kind === "awaits-land" ? tiered.awaits : null;

    const changed = changedPaths(checkout, baseRefOf(at.pr), reviewed);

    if (changed.kind === "failed") return refused(changed.why);

    const verdict = reviewRefusal(branch, at.pr, checkout, {
      reviewed,
      rebased: reviewed,
      paths: changed.paths,
    });

    return verdict === null
      ? { kind: "ready", pr: at.pr, paths: changed.paths, awaits }
      : refused(verdict);
  } catch (error) {
    return refused(messageOf(error));
  }
}

/** One pull request as a dry run found it: its head, base, tier, and why its review lets it through. */
function readyLine(
  lander: Lander,
  { pr, paths, awaits }: Extract<Checked, { kind: "ready" }>,
): string {
  const verdict = lander.tiering?.verdict ?? null;
  const approved = pr.labels.some((label) => label.name === LAND_OK);

  const tier =
    awaits ??
    (verdict === null
      ? "not tiered, its own guards hold it"
      : `tier ${verdict.tier} (${verdict.reason})${approved ? `, a ${LAND_OK} given to its change` : ""}`);

  const review =
    riskyPaths(paths, riskyOf(lander.checkout, BASE)).length > 0
      ? "a clean review verdict holds its patch"
      : "no risky path";

  return `#${pr.number} ${lander.branch} at ${short(lander.reviewed)}, based on ${pr.baseRefName}: ${tier}; ${review}`;
}

/** What a dry run prints for one branch that passed the checks before any wait. */
async function branchPlan(
  lander: Lander,
  passed: Extract<Checked, { kind: "ready" }>,
): Promise<Landing> {
  const { branch, checkout, gh, reviewed } = lander;
  const holds = run(["git", "merge-base", "--is-ancestor", BASE, reviewed], checkout).ok;
  const runs = await ciVerdict(gh, { sha: reviewed, event: "pull_request" });

  return {
    kind: "planned",
    lines: [
      readyLine(lander, passed),
      holds
        ? `its head holds ${BASE}`
        : `its head does not hold ${BASE}: land.ts would rebase it after the wait`,
      `its pull_request runs of ci.yml: ${runs.kind}`,
      `land.ts would take the landing lock, wait for CI, rebase on ${BASE}, push ${branch}, push it to ${DEV} and delete the remote branch`,
    ],
  };
}

function layerName(index: number, layers: readonly Layer[]): string {
  const layer = layers[index];

  return `layer ${index + 1} of ${layers.length}, #${layer?.number} (${layer?.branch})`;
}

/**
 * Lands `layers`, bottom to top, from the checkout holding the top branch, one added for the landing when none
 * holds it; in a dry run, from `cwd` when none holds it.
 */
async function landStack(
  layers: readonly Layer[],
  stack: number | null,
  cwd: string,
  waiting: Waiting,
  deps: Deps,
  dryRun: boolean,
): Promise<Landing> {
  const top = layers.at(-1);

  if (top === undefined) return refused("no open pull request to land");

  const outside = layers.find((layer) => !LANDABLE.test(layer.branch));

  if (outside !== undefined) {
    return refused(
      `#${outside.number}'s branch ${outside.branch} is not a ${LANDABLE_NAMES}: only those land on ${DEV}`,
    );
  }

  const worktrees = run(["git", "worktree", "list", "--porcelain"], cwd);

  if (!worktrees.ok) return refused(`git worktree list: ${worktrees.err}`);

  const held = checkoutOf(worktrees.out, top.branch);
  const from = { layers, stack, top, waiting, deps, readOnly: dryRun };

  if (held !== null) return stackFrom({ ...from, checkout: held, holds: true });

  if (dryRun) return stackFrom({ ...from, checkout: cwd, holds: false });

  const added = addCheckout(cwd, worktrees.out, top.branch);

  if (added.kind === "refused") return added;

  try {
    return await stackFrom({ ...from, checkout: added.path, holds: true });
  } finally {
    removeCheckout(cwd, added.path);
  }
}

interface StackLanding {
  readonly layers: readonly Layer[];
  readonly stack: number | null;
  readonly top: Layer;
  readonly checkout: string;
  readonly holds: boolean;
  readonly waiting: Waiting;
  readonly deps: Deps;
  readonly readOnly: boolean;
}

/** The checks of every layer before any wait, then the landing of the stack under the lock. */
async function stackFrom(landing: StackLanding): Promise<Landing> {
  const { layers, top, checkout, holds, waiting, deps, readOnly } = landing;
  const dirty = holds ? dirtyOf(checkout) : null;

  if (dirty !== null) return refused(dirty);

  const plain: Gh = (args) => ghCli(args, checkout);
  const gh = readOnly ? readOnlyGh(plain) : plain;
  const start = await startingHead({ gh, branch: top.branch, readOnly }, checkout, holds);

  if (start.kind === "refused") return start;

  const { head } = start;

  if (head !== top.head) {
    return refused(
      `${top.branch} is at ${short(head)} here and ${short(top.head)} on #${top.number}: push it, then land again`,
    );
  }

  // Each lower branch moves to the top: a commit of a layer the layer above does not hold would be dropped from it.
  for (const [index, layer] of layers.entries()) {
    const above = layers[index + 1];
    const missing = unserved(checkout, layer.head);

    if (missing !== null) {
      return refused(
        `#${layer.number} (${layer.branch}) at ${short(layer.head)}, ${missing}: it moved since it was read; land again`,
      );
    }

    if (
      above !== undefined &&
      !run(["git", "merge-base", "--is-ancestor", layer.head, above.head], checkout).ok
    ) {
      return refused(
        `#${layer.number} (${layer.branch}) at ${short(layer.head)} is not in #${above.number} (${above.branch}) at ${short(above.head)} above it: gh stack rebase, then gh stack push (github-flow:stacked-prs), then land again`,
      );
    }
  }

  const rerun = new Set<number>();

  const landers = layers.map((layer): Lander => ({
    branch: layer.branch,
    base: layer.base,
    readOnly,
    checkout,
    gh,
    waiting,
    deadline: waiting.clock.now() + waiting.timeoutMs,
    rerun,
    reviewed: layer.head,
    landsAs: landing.stack ?? top.number,
    tiering: { of: deps.tier, verdict: null },
  }));

  const passed: Extract<Checked, { kind: "ready" }>[] = [];

  for (const [index, lander] of landers.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- bottom to top, the first layer refused stops the landing and is named.
    const checked = await readyBeforeWait(lander);

    if (checked.kind === "refused") return refused(`${layerName(index, layers)}: ${checked.why}`);

    passed.push(checked);
  }

  if (!run(["git", "merge-base", "--is-ancestor", BASE, head], checkout).ok) {
    return refused(
      `the stack's top ${short(head)} does not hold ${BASE}: gh stack rebase, then gh stack push (github-flow:stacked-prs), then land again`,
    );
  }

  if (readOnly) return stackPlan(landing, landers, passed);

  const url = run(["git", "remote", "get-url", "--push", REMOTE], checkout);

  if (!url.ok) return refused(`git remote get-url --push ${REMOTE}: ${url.err}`);

  // The hour the landing waits at most starts once it holds the lock.
  return withLandingLock(url.out, top.branch, waiting, () => {
    const deadline = waiting.clock.now() + waiting.timeoutMs;

    return stackLocked(
      landing,
      landers.map((lander) => ({ ...lander, deadline })),
    );
  });
}

/** What a dry run prints for a stack whose layers passed the checks before any wait. */
async function stackPlan(
  { layers, stack, top }: StackLanding,
  landers: readonly Lander[],
  passed: readonly Extract<Checked, { kind: "ready" }>[],
): Promise<Landing> {
  const [first] = landers;

  const runs =
    first === undefined
      ? { kind: "none" }
      : await ciVerdict(first.gh, { sha: top.head, event: "workflow_dispatch" });

  const lower = layers.slice(0, -1).map((layer) => layer.branch);

  return {
    kind: "planned",
    lines: [
      `${stack === null ? `#${top.number} and the pull requests under it` : `stack #${stack}`}: ${layers.map((layer) => `#${layer.number} ${layer.branch}`).join(", ")}, bottom first`,
      ...landers.map((lander, index) => {
        const checked = passed[index];

        return `layer ${index + 1} of ${layers.length}: ${checked === undefined ? "" : readyLine(lander, checked)}`;
      }),
      `the top ${short(top.head)} holds ${BASE}`,
      `its workflow_dispatch runs of ci.yml: ${runs.kind}`,
      `land.ts would take the landing lock, ${runs.kind === "none" ? `dispatch ci.yml on ${top.branch}, wait for it` : runs.kind === "green" ? "reuse the green run" : "wait for the run on the top's head"}, push ${short(top.head)} to ${DEV} and to ${lower.join(", ")} in one atomic push, then delete the remote branches`,
    ],
  };
}

/**
 * The stack's landing under the lock: one `workflow_dispatch` run on the top's head, the layers read again, one
 * atomic push of `dev` and the lower branches to the top, every pull request read merged, the remote branches deleted.
 */
async function stackLocked(
  { layers, stack, top, checkout }: StackLanding,
  landers: readonly Lander[],
): Promise<Landing> {
  const topLander = landers.at(-1);

  if (topLander === undefined) return refused("no open pull request to land");

  const head = top.head;
  const query: CiQuery = { sha: head, event: "workflow_dispatch" };

  try {
    const found = await ciVerdict(topLander.gh, query);

    // A red run on this head stays red until it is re-run, as a pull request's does: settle re-runs it when its e2e
    // jobs alone failed, and names it otherwise; a run dispatched beside it would not clear it.
    if (found.kind === "none") await dispatchRun(topLander.gh, top.branch);

    const outcome: CiOutcome = found.kind === "green" ? found : await settle(topLander, query);

    if (outcome.kind !== "green") return refused(notGreen(topLander, top, head, outcome));

    for (const [index, lander] of landers.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- bottom to top, the first layer refused stops the landing and is named.
      const at = await pullRequestAt(lander, lander.reviewed);

      if (at.kind === "refused") return refused(`${layerName(index, layers)}: ${at.why}`);

      // oxlint-disable-next-line no-await-in-loop -- as above: a land-ok taken off during the wait refuses that layer.
      const tiered = await tierRefusal(lander, at.pr);

      if (tiered !== null) return refused(`${layerName(index, layers)}: ${tiered.why}`);
    }
  } catch (error) {
    return refused(messageOf(error));
  }

  const unfetched = fetchOrigin(checkout);

  if (unfetched !== null) return refused(unfetched);

  if (!run(["git", "merge-base", "--is-ancestor", BASE, head], checkout).ok) {
    return refused(
      `${DEV} moved while the stack waited, and its top ${short(head)} no longer holds ${BASE}: gh stack rebase, then gh stack push, then land again`,
    );
  }

  const drift = driftFrom(topLander, head);

  if (drift !== null) return refused(drift);

  const lower = landers.slice(0, -1);

  const pushed = run(
    [
      "git",
      "push",
      "--atomic",
      "--quiet",
      ...lower.map((lander) => `--force-with-lease=refs/heads/${lander.branch}:${lander.reviewed}`),
      REMOTE,
      `${head}:refs/heads/${DEV}`,
      ...lower.map((lander) => `${head}:refs/heads/${lander.branch}`),
    ],
    checkout,
    undefined,
    { [HOLDER_ENV]: String(process.pid) },
  );

  if (!pushed.ok) {
    return refused(
      movedOn(pushed.err)
        ? `${DEV} moved before the push, nothing moved: gh stack rebase, then gh stack push, then land again:\n${pushed.err}`
        : `the atomic push of ${short(head)} to ${DEV} and to the layers under the top was refused, nothing moved; fix what it names, then land again:\n${pushed.err}`,
    );
  }

  let states: readonly string[];

  try {
    states = await pollUntil(
      afterPush(topLander),
      () => Promise.all(layers.map((layer) => stateOf(topLander, layer.number))),
      (read) => read.every((state) => state === "MERGED"),
    );
  } catch (error) {
    return refused(
      `pushed ${short(head)} to ${DEV} and the layers, but the pull requests' states do not read: ${messageOf(error)}; no remote branch deleted`,
    );
  }

  const open = layers.filter((_, index) => states[index] !== "MERGED");

  if (open.length > 0) {
    return refused(
      `pushed ${short(head)} to ${DEV} and the layers, but GitHub reads ${open.map((layer) => `#${layer.number}`).join(", ")} not merged a minute later: no remote branch deleted; delete them once GitHub reads them merged`,
    );
  }

  const landed: { number: number; branch: string; remote: RemoteBranch }[] = [];

  for (const [index, lander] of landers.entries()) {
    const layer = layers[index];

    if (layer !== undefined) {
      landed.push({
        ...layer,
        // oxlint-disable-next-line no-await-in-loop -- one deletion at a time, each under its own lease.
        remote: await deleteRemote(afterPush(lander), layer.number, head),
      });
    }
  }

  return {
    kind: "landedStack",
    dev: head,
    stack,
    layers: landed.map(({ number, branch, remote }) => ({ number, branch, remote })),
  };
}

/** The landing once it holds the lock: the wait for CI, the rebase and the pushes, `touched` the paths its head changes. */
async function landLocked(lander: Lander, touched: readonly string[]): Promise<Landing> {
  const { branch, checkout, reviewed } = lander;
  // The head the remote branch holds: the reviewed one, then each one this run pushed.
  let pushed = reviewed;
  let e2e = touched.some((path) => isE2ePath(path));
  // The pull request read once `pushed` was ready; null while `pushed` waits for its runs.
  let pr: PullRequest | null = null;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    if (pr === null) {
      const beforeWait = fetchOrigin(checkout);

      if (beforeWait !== null) return refused(beforeWait);

      // dev takes a head that does not hold origin/dev only rebased, a new commit: an e2e run on this one is lost.
      const based = run(["git", "merge-base", "--is-ancestor", BASE, pushed], checkout).ok;
      let waited: Ready;

      try {
        waited = await ready(lander, pushed, e2e && based);
      } catch (error) {
        waited = refused(messageOf(error));
      }

      if (waited.kind === "refused") return waited;

      ({ pr } = waited);
    }

    const unfetched = fetchOrigin(checkout);

    if (unfetched !== null) return refused(unfetched);

    const beforeRebase = driftFrom(lander, pushed);

    if (beforeRebase !== null) return refused(beforeRebase);

    const rebase = run(["git", "rebase", "--quiet", BASE], checkout);

    if (!rebase.ok) {
      run(["git", "rebase", "--abort"], checkout);

      return refused(
        `${branch} does not rebase cleanly on ${BASE}: rebase it by hand, push, then land\n${rebase.err}`,
      );
    }

    const rebased = headOf(checkout);

    if (rebased === null)
      return refused(`git rev-parse HEAD failed in ${checkout} after the rebase`);

    const changed = changedPaths(checkout, BASE);

    if (changed.kind === "failed") {
      run(["git", "reset", "--quiet", "--hard", pushed], checkout);

      return refused(changed.why);
    }

    const { paths } = changed;
    const review = reviewRefusal(branch, pr, checkout, { reviewed, rebased, paths });

    if (review !== null) {
      run(["git", "reset", "--quiet", "--hard", pushed], checkout);

      return refused(review);
    }

    // The pre-push gates run against the checkout's node_modules: a rebase that brings in
    // another lockfile must install it first, or the gates read the old dependencies.
    const lockChanged = !run(
      ["git", "diff", "--quiet", pushed, rebased, "--", ...LOCKFILES],
      checkout,
    ).ok;

    if (lockChanged) {
      const install = run(["bun", "install", "--frozen-lockfile"], checkout);

      if (!install.ok) {
        const duringInstall = driftFrom(lander, rebased);

        if (duringInstall !== null) {
          return refused(
            `bun install --frozen-lockfile failed after the rebase on ${BASE}, and ${duringInstall}:\n${install.err}`,
          );
        }

        run(["git", "reset", "--quiet", "--hard", pushed], checkout);

        const restored = run(["bun", "install", "--frozen-lockfile"], checkout).ok;

        const modules = restored
          ? "its node_modules reinstalled from that head's lockfile"
          : `its node_modules may be half-installed: run bun install --frozen-lockfile in ${checkout}`;

        return refused(
          `bun install --frozen-lockfile failed after the rebase on ${BASE}; ${branch} is back at ${short(pushed)}, ${modules}:\n${install.err}`,
        );
      }
    }

    const beforeBranchPush = driftFrom(lander, rebased);

    if (beforeBranchPush !== null) return refused(beforeBranchPush);

    const branchPush = run(
      ["git", "push", "--quiet", `--force-with-lease=${branch}:${pushed}`, REMOTE, branch],
      checkout,
    );

    if (!branchPush.ok) {
      const duringPush = driftFrom(lander, rebased);

      if (duringPush !== null) {
        return refused(`the push of ${branch} was refused, and ${duringPush}:\n${branchPush.err}`);
      }

      run(["git", "reset", "--quiet", "--hard", pushed], checkout);

      return refused(
        `the push of ${branch} was refused; it is back at ${short(pushed)}, the head ${REMOTE} holds:\n${branchPush.err}`,
      );
    }

    const fresh = rebased !== pushed;

    pushed = rebased;
    e2e = paths.some((path) => isE2ePath(path));

    if (fresh && e2e) {
      pr = null;
      continue;
    }

    const beforeDevPush = driftFrom(lander, rebased);

    if (beforeDevPush !== null) return refused(beforeDevPush);

    const devPush = run(
      ["git", "push", "--quiet", REMOTE, `${branch}:${DEV}`],
      checkout,
      undefined,
      { [HOLDER_ENV]: String(process.pid) },
    );

    if (devPush.ok) {
      return {
        kind: "landed",
        dev: rebased,
        pr: pr.number,
        remote: await deleteRemote(afterPush(lander), pr.number, rebased),
      };
    }

    if (!movedOn(devPush.err)) {
      return refused(
        `pushed ${branch} at ${short(rebased)}, but the push to ${DEV} was refused; fix what it names, then land again:\n${devPush.err}`,
      );
    }
  }

  return refused(`${BASE} moved during each of ${ATTEMPTS} attempts: land again`);
}

type DevCopyRun =
  | { readonly kind: "ran"; readonly exitCode: number }
  | { readonly kind: "failed"; readonly why: string };

/** Runs `origin/dev`'s copy of this script on `args` from `cwd`, extracted to a temporary directory. */
function runDevCopy(args: readonly string[], cwd: string): DevCopyRun {
  const fetched = run(["git", "fetch", "--quiet", REMOTE], cwd);

  if (!fetched.ok) return { kind: "failed", why: `git fetch: ${fetched.err}` };

  const copy = mkdtempSync(join(tmpdir(), "land-dev-"));

  try {
    const archive = join(copy, "dev.tar");
    const archived = run(["git", "archive", `--output=${archive}`, BASE], cwd);

    if (!archived.ok) return { kind: "failed", why: `git archive ${BASE}: ${archived.err}` };

    const extracted = run(["tar", "-x", "-f", archive, "-C", copy], cwd);

    if (!extracted.ok) return { kind: "failed", why: `tar -x ${archive}: ${extracted.err}` };

    // Started in the copy, the checkout named in the environment: bun runs the `preload` of the `bunfig.toml` it
    // starts in, which a branch could set.
    const landed = Bun.spawnSync([process.execPath, join(copy, "scripts", "land.ts"), ...args], {
      cwd: copy,
      env: { ...process.env, [DEV_COPY]: "1", [LAND_CWD]: cwd },
      stdio: ["inherit", "inherit", "inherit"],
    });

    return { kind: "ran", exitCode: landed.exitCode ?? 1 };
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

/** How long one landing of the worker may run: an hour for the landing lock, an hour for CI, the rest to push. */
const WORKER_LANDING_MS = 3 * 60 * 60 * 1000;

/**
 * The landing worker's hands from `checkout`: each target lands through this copy of the script, run from the copy
 * as `runDevCopy` runs it, its output kept for the worker's log, killed past `WORKER_LANDING_MS`. A SIGTERM would
 * wait for the git command the landing blocks in, a rebase waiting for a passphrase among them; the kernel releases
 * the landing lock of a killed landing, and the git command it ran ends on its own, or with the pass's other
 * processes when systemd stops the pass.
 */
function workerDeps(checkout: string): WorkerDeps {
  const url = run(["git", "remote", "get-url", "--push", REMOTE], checkout);

  if (!url.ok) throw new Error(`git remote get-url --push ${REMOTE}: ${url.err}`);

  return {
    gh: (args) => ghCli(args, checkout),
    land: (target) => {
      const landed = Bun.spawnSync(
        [process.execPath, join(import.meta.dir, "land.ts"), String(target)],
        {
          cwd: join(import.meta.dir, ".."),
          env: { ...process.env, [DEV_COPY]: "1", [LAND_CWD]: checkout },
          stdout: "pipe",
          stderr: "pipe",
          timeout: WORKER_LANDING_MS,
          killSignal: "SIGKILL",
        },
      );

      const stopped = landed.exitedDueToTimeout
        ? `land: the landing ran past ${WORKER_LANDING_MS / 3_600_000} h and was killed\n`
        : "";

      return {
        exitCode: landed.exitCode ?? 1,
        stdout: landed.stdout.toString(),
        stderr: `${landed.stderr.toString()}${stopped}`,
      };
    },
    landingHeld: () => {
      try {
        return runState(lockPaths(url.out)).kind === "running";
      } catch (error) {
        // The holder file went between its check and its read: the landing that held the lock was releasing it.
        if (isErrno(error, "ENOENT")) return true;
        throw error;
      }
    },
    probeSigning: () => {
      probeSigning(checkout);
    },
    holdsDev: (head) => run(["git", "merge-base", "--is-ancestor", BASE, head], checkout).ok,
    now: () => Date.now(),
    dir: landingDir(),
    repository: repositoryOf(url.out),
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (process.env[DEV_COPY] === undefined) {
    const devCopy = runDevCopy(args, process.cwd());

    if (devCopy.kind === "ran") process.exit(devCopy.exitCode);

    console.error(`land: ${BASE}'s copy of land.ts did not run: ${devCopy.why}`);
    process.exit(1);
  }

  const usage = [
    `Usage: bun ./scripts/land.ts <feature/...|fix/...|renovate/...|${ROLLING_BRANCH}|n|#n> [--dry-run]`,
    "       bun ./scripts/land.ts --worker --once",
  ].join("\n");

  let parsed;

  try {
    parsed = parseArgs({
      args,
      options: {
        "dry-run": { type: "boolean" },
        worker: { type: "boolean" },
        once: { type: "boolean" },
      },
      allowPositionals: true,
    });
  } catch {
    console.error(usage);
    process.exit(2);
  }

  const { worker, once, "dry-run": dryRun } = parsed.values;
  const [target, ...rest] = parsed.positionals;
  const from = process.env[LAND_CWD] ?? process.cwd();

  // Read once: a command the landing runs, the pre-push gates' tests included, must not inherit it.
  delete process.env[LAND_CWD];

  if (worker === true && once === true && target === undefined && dryRun !== true) {
    try {
      for (const line of await runWorkerOnce(workerDeps(from))) console.log(line);
    } catch (error) {
      console.error(`landing-worker: ${messageOf(error)}`);
      process.exitCode = 1;
    }

    process.exit();
  }

  if (worker === true || once === true || target === undefined || rest.length > 0) {
    console.error(usage);
    process.exit(2);
  }

  const landing = await land(target, from, WAITING, DEPS, dryRun === true);
  const runOnDev = `its run on ${DEV}: gh run list --branch ${DEV} --event push --limit 1`;

  switch (landing.kind) {
    case "landed": {
      const remote =
        landing.remote.kind === "deleted"
          ? "remote branch deleted"
          : `remote branch kept: ${landing.remote.why}`;

      const name = NUMBER_TARGET.test(target) ? `#${landing.pr}` : `${target}`;
      const pr = NUMBER_TARGET.test(target) ? "" : ` (#${landing.pr})`;

      console.log(`landed ${name} on ${DEV} at ${short(landing.dev)}${pr}; ${remote}; ${runOnDev}`);
      break;
    }

    case "landedStack": {
      const keptBranches = landing.layers.flatMap(({ branch, remote }) =>
        remote.kind === "kept" ? [`${branch} kept: ${remote.why}`] : [],
      );

      const remote =
        keptBranches.length === 0
          ? "remote branches deleted"
          : `remote branches deleted but ${keptBranches.join("; ")}`;

      const stack = landing.stack === null ? "" : ` (stack #${landing.stack})`;

      console.log(
        `landed ${landing.layers.map(({ number }) => `#${number}`).join(" ")}${stack} on ${DEV} at ${short(landing.dev)}; ${remote}; ${runOnDev}`,
      );
      break;
    }

    case "planned":
      console.log(landing.lines.join("\n"));
      break;

    case "refused":
      console.error(`land: ${landing.why}`);
      process.exitCode = 1;
  }
}
