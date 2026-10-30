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
 * and `chore/claude-code-types`, no checkout holding it, the types branch held
 * where the types run recreates its worktree, tracked changes
 * there, a pull request not open against `dev`, or whose head is not the
 * local head within a minute. Then it waits, an hour at most in all, until
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

import { mkdtempSync, rmSync } from "node:fs";
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
import { riskyOf, riskyPaths } from "./tier-floor.ts";

/** Set in the environment of `origin/dev`'s copy, which runs the landing itself. */
const DEV_COPY = "LAND_DEV_COPY";

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

async function readPullRequest(lander: Lander): Promise<PullRequest> {
  const out = await lander.gh([
    "pr",
    "view",
    lander.branch,
    "--json",
    "number,state,baseRefName,headRefOid,labels,comments",
  ]);

  try {
    // SAFETY: gh prints exactly the fields asked for, and a pull request with a field missing can only fail to read
    // as open, against dev and at the head waited for.
    return JSON.parse(out);
  } catch {
    throw new Error(`gh printed no pull request for ${lander.branch}: ${out.trim()}`);
  }
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

  return pullRequestAt(lander, sha);
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

export async function land(
  branch: string,
  cwd: string,
  waiting: Waiting = WAITING,
): Promise<Landing> {
  if (!LANDABLE.test(branch) && branch !== ROLLING_BRANCH) {
    return refused(`${branch} is not a ${LANDABLE_NAMES}: only those land on ${DEV}`);
  }

  const worktrees = run(["git", "worktree", "list", "--porcelain"], cwd);

  if (!worktrees.ok) return refused(`git worktree list: ${worktrees.err}`);

  const checkout = checkoutOf(worktrees.out, branch);

  if (checkout === null) return refused(`no checkout holds ${branch}: check it out, then land`);

  if (branch === ROLLING_BRANCH && samePath(checkout, await worktreePath(cwd))) {
    return refused(
      `${checkout} is where the types run recreates its worktree, under a landing: move that checkout elsewhere (git worktree move ${checkout} <path>), then land`,
    );
  }

  const dirty = dirtyOf(checkout);

  if (dirty !== null) return refused(dirty);

  const reviewed = headOf(checkout);

  if (reviewed === null) return refused(`git rev-parse HEAD failed in ${checkout}`);

  const touched = changedPaths(checkout, BASE, reviewed);

  if (touched.kind === "failed") return refused(touched.why);

  const lander: Lander = {
    branch,
    checkout,
    gh: (args) => ghCli(args, checkout),
    waiting,
    deadline: waiting.clock.now() + waiting.timeoutMs,
    rerun: new Set(),
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

    const landed = Bun.spawnSync([process.execPath, join(copy, "scripts", "land.ts"), ...args], {
      cwd,
      env: { ...process.env, [DEV_COPY]: "1" },
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

  const landing = await land(branch, process.cwd());

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
