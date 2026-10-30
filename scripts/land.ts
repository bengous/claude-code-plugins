#!/usr/bin/env bun

/**
 * Land a reviewed branch on `dev`: the "Land a branch" procedure of
 * `docs/repo-ops/git.md` as one command an agent runs once, in the background,
 * without a prompt. It waits by itself and ends on one verdict line.
 *
 *   bun ./scripts/land.ts <feature/...|fix/...|renovate/...|chore/claude-code-types>
 *
 * Runs `origin/dev`'s copy of itself, on the arguments as given: after a
 * fetch, `scripts/` and `agent-hooks/` as `origin/dev` holds them are
 * extracted to a temporary directory and run there, so a branch that edits
 * the landing lands under the rule already on `dev`.
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
 * this script, so `origin/dev`'s, once per landing, on the pull request read
 * before and after the wait for CI; a `tier:human` label already on the pull
 * request keeps it human. The pull request gets the label of its tier. A human
 * one lands only with a `land-ok` label given to its change: the head GitHub
 * held when the label was added, by its push times, has the patch of the head
 * the landing starts from. The agent-hooks guard lets an agent add the label
 * only on the human's words. A `land-ok` whose change is no longer the head's
 * comes off, with a comment naming the commits since and GitHub's compare view
 * of the two heads: the human reads those alone, then says « land #n » again,
 * which adds the label anew. A low one without it is refused while a `red-dev`
 * issue is open.
 * Renovate's branches and the types branch have guards of their own.
 *
 * Then it waits, an hour at most in all, until
 * every `ci.yml` run of that head is green (`scripts/ci-wait.ts`), a run red
 * in its e2e jobs alone re-run once. A branch touching the e2e paths whose
 * head holds `origin/dev` and has no green `e2e` check run, the pre-push
 * gate's own predicate, gets the `e2e` label, taken off first when it is on,
 * and waits for the run it starts; a head that does not hold it is rebased
 * first, as `dev` would only take a new commit. Then, in the checkout holding
 * the branch, refused before each rebase and each push unless it is still
 * clean at the head the landing left there: fetch, rebase on `origin/dev`,
 * refuse a rebased branch that touches a path of
 * `origin/dev`'s `profile.review.risky` without a clean review verdict for
 * its patch on the pull request (`scripts/review-verdict.ts`); while that
 * profile does not read, every path is risky. Then install the lockfile when
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
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  type CheckRun,
  checkRunsOf,
  isE2eCheck,
  isE2ePath,
  refusalFor,
} from "./check-e2e-green.ts";
import {
  type CiOutcome,
  type CiQuery,
  type CiRun,
  type Clock,
  ciVerdict,
  type Gh,
  ghCli,
  REGISTRATION_MS,
  SYSTEM_CLOCK,
  waitFor,
} from "./ci-wait.ts";
import { ROLLING_BRANCH, worktreePath } from "./claude-code-types.ts";
import { run } from "./lib/run.ts";
import { LABEL as RED_DEV } from "./red-dev.ts";
import {
  BASE,
  type Comment,
  DEV,
  REMOTE,
  patchIdOf,
  recordCommand,
  short,
  verdictsOf,
} from "./review-verdict.ts";
import { riskyOf, riskyPaths, type Tier, type Verdict } from "./tier-floor.ts";

/** Set in the environment of `origin/dev`'s copy, which runs the landing itself. */
const DEV_COPY = "LAND_DEV_COPY";

/** Set in the environment of `origin/dev`'s copy: the directory the landing was asked from. */
const LAND_CWD = "LAND_CWD";

/** The directories `origin/dev`'s copy needs: this script, its imports, the profile's parser. */
const DEV_COPY_PATHS = ["scripts", "agent-hooks"];

const LANDABLE = /^(?:feature|fix|renovate)\/[\w./-]+$/u;

const LANDABLE_NAMES = `feature/, fix/ or renovate/ branch, or ${ROLLING_BRANCH}`;

const ATTEMPTS = 3;

const LOCKFILES = ["package.json", "bun.lock"];

const MOVED = /\[rejected\][^\n]*\((?:fetch first|non-fast-forward)\)/u;

const E2E_LABEL = "e2e";

const GREEN_JOB = new Set(["success", "skipped", "neutral"]);

const PR_NUMBER = /^\d+$/u;

/** Renovate's branches: `scripts/renovate-agent.ts` and the verdict it posts guard them, not the tier. */
const BOT_BRANCH = /^renovate\//u;

/** The human's ok on one pull request, added only on the human's own words (`profile.approvals.labels`). */
export const LAND_OK = "land-ok";

export const TIER_LABELS: Readonly<
  Record<Tier, { readonly name: string; readonly color: string; readonly description: string }>
> = {
  low: { name: "tier:low", color: "0E8A16", description: "Lands on green checks without a human" },
  human: { name: "tier:human", color: "D93F0B", description: "Waits for the human's land #N" },
};

const TIER_LINE = /^(low|human) (.+)$/u;

/** A commit's oid, not git's zero oid, which is the `after` of a branch's deletion. */
const COMMIT = /^(?!0+$)[0-9a-f]{40,64}$/u;

/** The tier of the branch held in `checkout`, whose pull request is `pr`. */
export type Tiering = (checkout: string, pr: number) => Promise<Verdict>;

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
  | { readonly kind: "refused"; readonly why: string };

type Refused = Extract<Landing, { readonly kind: "refused" }>;

type Ready = { readonly kind: "ready"; readonly pr: PullRequest } | Refused;

/** What one landing carries through its waits. */
interface Lander {
  readonly branch: string;
  readonly checkout: string;
  readonly gh: Gh;
  readonly waiting: Waiting;
  readonly deadline: number;
  /** The runs this landing re-ran, each once at most. */
  readonly rerun: Set<number>;
  /** The head the landing started from, whose patch a `land-ok` must have been given to. */
  readonly reviewed: string;
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

/** Why a branch may not land through `pr`, whatever its head and its runs; null when it may. */
export function refusalOf(pr: PullRequest): string | null {
  const name = `#${pr.number}`;

  if (pr.state !== "OPEN") return `${name} is ${pr.state.toLowerCase()}, not open`;

  if (pr.baseRefName !== DEV) {
    return `${name} targets ${pr.baseRefName}, not ${DEV}: a stacked layer lands with gh stack (docs/repo-ops/git.md)`;
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
 * Why the branch, `reviewed` on its pull request and `rebased` on `origin/dev` here, changing `paths`, may not land
 * without another review; null when it touches no risky path or a clean verdict holds its patch. Read from
 * `origin/dev`, never the checkout, so a branch cannot loosen the rule it lands under; while that profile does not
 * read, every path is risky, and a verdict still lands the branch that repairs it.
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

  const landing = patchIdOf(checkout, BASE, rebased);

  if (landing.kind === "failed") return landing.why;

  const verdicts = verdictsOf(pr.comments);

  if (verdicts.has(landing.id)) return null;

  const before = patchIdOf(checkout, BASE, reviewed);

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
export async function tierScript(checkout: string, pr: number): Promise<Verdict> {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "tier.ts"),
      "--pr",
      String(pr),
      "--checkout",
      checkout,
    ],
    { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" },
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

/** Puts the label of `tier` on the pull request, taking `tier:low` off a human one: a tier only goes up. */
async function labelTier(lander: Lander, labels: ReadonlySet<string>, tier: Tier): Promise<void> {
  const { name, color, description } = TIER_LABELS[tier];
  const low = TIER_LABELS.low.name;

  if (tier === "human" && labels.has(low)) {
    await lander.gh(["pr", "edit", lander.branch, "--remove-label", low]);
  }

  if (labels.has(name)) return;

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
  await lander.gh(["pr", "edit", lander.branch, "--add-label", name]);
}

/**
 * The branch's head on GitHub when `added`: the last push GitHub lists before that time. Read from the server's push
 * times, not a commit's date, which its author sets.
 */
async function headPushedBefore(lander: Lander, added: string): Promise<string | null> {
  const before = Date.parse(added);
  let last: Push | null = null;

  for (const push of await pushesOf(lander)) {
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

/**
 * Null when the pull request carries a `land-ok` given to the change that lands: the head GitHub held when the label
 * was added has the patch of the head this landing started from. A rebase that keeps the patch, `land.ts`'s own
 * included, keeps the ok; a commit after it does not, and that ok comes off (`voidApproval`). An ok whose head or
 * patch cannot be read is refused as it is: nothing is taken off on a read that failed.
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

  if (approved === lander.reviewed) return null;

  const given = `with a ${LAND_OK} given to ${short(approved)}`;

  if (!run(["git", "cat-file", "-e", `${approved}^{commit}`], lander.checkout).ok) {
    const fetched = run(["git", "fetch", "--quiet", REMOTE, approved], lander.checkout);

    if (!fetched.ok) return `${given}, which ${REMOTE} no longer serves: ${fetched.err.trim()}`;
  }

  const then = patchIdOf(lander.checkout, BASE, approved);

  if (then.kind === "failed") return `${given}, whose patch does not read: ${then.why}`;

  const now = patchIdOf(lander.checkout, BASE, lander.reviewed);

  if (now.kind === "failed") return `${given}, and a head whose patch does not read: ${now.why}`;

  if (then.id === now.id) return null;

  return voidApproval(lander, pr, approved);
}

/**
 * Takes off a `land-ok` whose change is no longer the pull request's: the human's next « land #n » adds it again,
 * as a new event GitHub dates, which a label left on would not be. The comment, posted first so a failed removal
 * loses nothing, leaves the human what to read before that: the commits since the head the ok covered, those with
 * no patch among the ones it covered and not on `origin/dev`, which a rebase brings in, each linked; and GitHub's
 * compare view of the two heads when the ok's head leads to this one, since after a rebase that view starts from
 * the old base and shows the rebase too.
 */
async function voidApproval(lander: Lander, pr: PullRequest, approved: string): Promise<string> {
  const { branch, checkout, reviewed } = lander;

  const since = run(
    [
      "git",
      "log",
      "--right-only",
      "--cherry-pick",
      "--no-merges",
      "--format=%H %s",
      `${approved}...${reviewed}`,
      `^${BASE}`,
    ],
    checkout,
  );

  if (!since.ok) {
    throw new Error(`git log ${short(approved)}...${short(reviewed)}: ${since.err.trim()}`);
  }

  const repo = pr.url.replace(/\/pull\/\d+$/u, "");

  const commits = since.out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [sha = "", ...subject] = line.split(" ");

      return `- ${short(sha)} ${subject.join(" ")} (${repo}/commit/${sha})`;
    });

  const linear = run(["git", "merge-base", "--is-ancestor", approved, reviewed], checkout).ok;
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
      : `the commits below; the compare view ${compare} would show the rebase too`;

  const where = linear ? compare : commits.length === 0 ? direct : "the commits its comment links";

  await lander.gh([
    "pr",
    "comment",
    branch,
    "--body",
    [
      `<!-- land-ok: void approved=${approved} head=${reviewed} -->`,
      `The human's \`${LAND_OK}\` covered ${short(approved)}; ${changed}, so the label is off. To read before the next « land #${pr.number} »: ${toRead}`,
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

/**
 * Why `pr` may not land at its tier, or null when it may: a human one without a `land-ok` given to its change, a low
 * one without it while `dev` is red. The tier is the branch's, read once per landing, raised by a `tier:human` label
 * an earlier pass left; its label goes on the pull request on the way, and a `land-ok` given to another change
 * comes off on the way too, named in the refusal.
 */
async function tierRefusal(lander: Lander, pr: PullRequest): Promise<string | null> {
  const { tiering } = lander;

  if (tiering === null) return null;

  tiering.verdict ??= await tiering.of(lander.checkout, pr.number);

  const labels = new Set(pr.labels.map((label) => label.name));
  const raised = tiering.verdict.tier === "low" && labels.has(TIER_LABELS.human.name);
  const tier: Tier = raised ? "human" : tiering.verdict.tier;

  await labelTier(lander, labels, tier);

  if (tier === "human") {
    const approval = await approvalOf(lander, pr, labels);

    if (approval === null) return null;

    const why = raised
      ? `its tier:human label, left by an earlier pass; tier.ts now says low: ${tiering.verdict.reason}`
      : tiering.verdict.reason;

    return `#${pr.number} is tier:human (${why}), ${approval}: it lands once the human types « land #${pr.number} » in a session; stop`;
  }

  const red = await redDevIssues(lander);

  if (red.length === 0) return null;

  const approval = await approvalOf(lander, pr, labels);

  if (approval === null) return null;

  const unattended = `${DEV} is red (${red.join(", ")}): no unattended landing until it is green`;

  return labels.has(LAND_OK) ? `${unattended}; #${pr.number}, ${approval}` : unattended;
}

function remaining(lander: Lander): number {
  return Math.max(0, lander.deadline - lander.waiting.clock.now());
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
    (read) => read.headRefOid === sha || refusalOf(read) !== null,
  );

  const refusal = refusalOf(pr);

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
  pr: PullRequest,
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

  const before = await tierRefusal(lander, at.pr);

  if (before !== null) return refused(before);

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

  return tiered === null ? after : refused(tiered);
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
    return kept(error instanceof Error ? error.message : String(error));
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
 * worker's rebase. A head GitHub never held is left for the landing to refuse.
 */
async function caughtUp(
  { gh, branch }: Pick<Lander, "gh" | "branch">,
  checkout: string,
): Promise<string | null> {
  const unfetched = fetchOrigin(checkout);

  if (unfetched !== null) return unfetched;

  const head = headOf(checkout);

  if (head === null) return `git rev-parse HEAD failed in ${checkout}`;

  const { headRefOid } = await readPullRequest({ gh, branch });

  if (headRefOid === head) return null;

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

export async function land(
  branch: string,
  cwd: string,
  waiting: Waiting = WAITING,
  deps: Deps = DEPS,
): Promise<Landing> {
  if (!LANDABLE.test(branch) && branch !== ROLLING_BRANCH) {
    return refused(`${branch} is not a ${LANDABLE_NAMES}: only those land on ${DEV}`);
  }

  const worktrees = run(["git", "worktree", "list", "--porcelain"], cwd);

  if (!worktrees.ok) return refused(`git worktree list: ${worktrees.err}`);

  const held = checkoutOf(worktrees.out, branch);

  if (held === null) {
    const added = addCheckout(cwd, worktrees.out, branch);

    if (added.kind === "refused") return added;

    try {
      return await landFrom(branch, added.path, waiting, deps);
    } finally {
      removeCheckout(cwd, added.path);
    }
  }

  if (branch === ROLLING_BRANCH && samePath(held, await worktreePath(cwd))) {
    return refused(
      `${held} is where the types run recreates its worktree, under a landing: move that checkout elsewhere (git worktree move ${held} <path>), then land`,
    );
  }

  return landFrom(branch, held, waiting, deps);
}

/** The landing of `branch` from `checkout`, the clean checkout that holds it. */
async function landFrom(
  branch: string,
  checkout: string,
  waiting: Waiting,
  deps: Deps,
): Promise<Landing> {
  const dirty = dirtyOf(checkout);

  if (dirty !== null) return refused(dirty);

  const gh: Gh = (args) => ghCli(args, checkout);

  try {
    const behind = await caughtUp({ gh, branch }, checkout);

    if (behind !== null) return refused(behind);
  } catch (error) {
    return refused(error instanceof Error ? error.message : String(error));
  }

  const reviewed = headOf(checkout);

  if (reviewed === null) return refused(`git rev-parse HEAD failed in ${checkout}`);

  const touched = changedPaths(checkout, BASE, reviewed);

  if (touched.kind === "failed") return refused(touched.why);

  const lander: Lander = {
    branch,
    checkout,
    gh,
    waiting,
    deadline: waiting.clock.now() + waiting.timeoutMs,
    rerun: new Set(),
    reviewed,
    tiering:
      BOT_BRANCH.test(branch) || branch === ROLLING_BRANCH
        ? null
        : { of: deps.tier, verdict: null },
  };

  // The head the remote branch holds: the reviewed one, then each one this run pushed.
  let pushed = reviewed;
  let e2e = touched.paths.some((path) => isE2ePath(path));
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
        waited = refused(error instanceof Error ? error.message : String(error));
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

    const devPush = run(["git", "push", "--quiet", REMOTE, `${branch}:${DEV}`], checkout);

    if (devPush.ok) {
      return {
        kind: "landed",
        dev: rebased,
        pr: pr.number,
        remote: await deleteRemote(lander, pr.number, rebased),
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
    const archived = run(["git", "archive", `--output=${archive}`, BASE, ...DEV_COPY_PATHS], cwd);

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

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (process.env[DEV_COPY] === undefined) {
    const devCopy = runDevCopy(args, process.cwd());

    if (devCopy.kind === "ran") process.exit(devCopy.exitCode);

    console.error(`land: ${BASE}'s copy of land.ts did not run: ${devCopy.why}`);
    process.exit(1);
  }

  const [branch] = args;

  if (branch === undefined || args.length > 1) {
    console.error(
      `Usage: bun ./scripts/land.ts <feature/...|fix/...|renovate/...|${ROLLING_BRANCH}>`,
    );
    process.exit(2);
  }

  const from = process.env[LAND_CWD] ?? process.cwd();

  // Read once: a command the landing runs, the pre-push gates' tests included, must not inherit it.
  delete process.env[LAND_CWD];

  const landing = await land(branch, from);

  if (landing.kind === "landed") {
    const remote =
      landing.remote.kind === "deleted"
        ? "remote branch deleted"
        : `remote branch kept: ${landing.remote.why}`;

    console.log(
      `landed ${branch} on ${DEV} at ${short(landing.dev)} (#${landing.pr}); ${remote}; its run on ${DEV}: gh run list --branch ${DEV} --event push --limit 1`,
    );
  } else {
    console.error(`land: ${landing.why}`);
    process.exitCode = 1;
  }
}
