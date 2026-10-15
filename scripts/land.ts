#!/usr/bin/env bun

/**
 * Land a reviewed branch on `dev`: the "Land a branch" procedure of
 * `docs/repo-ops/git.md` as one command an agent runs without a prompt.
 *
 *   bun ./scripts/land.ts <feature/...|fix/...>
 *
 * Refused before any push: a branch outside `feature/` and `fix/`, no
 * checkout holding it, tracked changes there, a local head that is not its
 * pull request's head, a pull request not open against `dev`, a check not
 * green on that head. Then, in the checkout holding the branch: fetch,
 * rebase on `origin/dev`, push the branch with a lease on the head last
 * pushed, push it to `dev`. A `dev` push rejected because `origin/dev` moved
 * starts over from the fetch, three attempts at most. A rebase that makes a
 * new commit on a branch touching the e2e paths stops after the branch push:
 * that commit needs its own e2e run before `dev` takes it. The pre-push hook
 * runs the gates and the e2e gate on every push, as for a push by hand.
 */

import { isE2ePath } from "./check-e2e-green.ts";

const REMOTE = "origin";

const DEV = "dev";

const LANDABLE = /^(?:feature|fix)\/[\w./-]+$/u;

const ATTEMPTS = 3;

const GREEN = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

const PENDING = new Set(["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED", "EXPECTED"]);

const MOVED = /\[rejected\][^\n]*\((?:fetch first|non-fast-forward)\)/u;

/** Each check as its name, its start, and its conclusion or, while it runs, its status. */
const PULL_REQUEST_JQ = `{number, state, baseRefName, headRefOid, checks: [(.statusCheckRollup // [])[] | {name: (.name // .context), startedAt: (.startedAt // .createdAt // ""), state: (if .__typename == "CheckRun" then (if .status == "COMPLETED" then .conclusion else .status end) else .state end)}]}`;

export interface Check {
  readonly name: string;
  readonly startedAt: string;
  readonly state: string;
}

export interface PullRequest {
  readonly number: number;
  readonly state: string;
  readonly baseRefName: string;
  readonly headRefOid: string;
  readonly checks: readonly Check[];
}

export type Landing =
  | { readonly kind: "landed"; readonly dev: string; readonly pr: number }
  | { readonly kind: "refused"; readonly why: string };

interface Run {
  readonly ok: boolean;
  readonly out: string;
  readonly err: string;
}

function run(cmd: readonly string[], cwd: string): Run {
  const result = Bun.spawnSync([...cmd], { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });

  return {
    ok: result.exitCode === 0,
    out: result.stdout.toString().trim(),
    err: result.stderr.toString().trim(),
  };
}

function refused(why: string): Landing {
  return { kind: "refused", why };
}

function headOf(checkout: string): string | null {
  const head = run(["git", "rev-parse", "HEAD"], checkout);

  return head.ok && head.out !== "" ? head.out : null;
}

function short(commit: string): string {
  return commit.slice(0, 8);
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

/** The newest check of each name: a re-run supersedes the attempt before it, as in `gh pr checks`. */
export function latestChecks(checks: readonly Check[]): readonly Check[] {
  const newest = new Map<string, Check>();

  for (const check of checks) {
    const kept = newest.get(check.name);

    if (kept === undefined || check.startedAt > kept.startedAt) newest.set(check.name, check);
  }

  return [...newest.values()];
}

/** Why `branch`, at `head` here, may not land through `pr`; null when it may. */
export function refusalOf(branch: string, pr: PullRequest, head: string): string | null {
  const name = `#${pr.number}`;

  if (pr.state !== "OPEN") return `${name} is ${pr.state.toLowerCase()}, not open`;

  if (pr.baseRefName !== DEV) {
    return `${name} targets ${pr.baseRefName}, not ${DEV}: a stacked layer lands with gh stack (docs/repo-ops/git.md)`;
  }

  if (pr.headRefOid !== head) {
    return `${branch} is at ${short(head)} here and ${short(pr.headRefOid)} on ${name}: push it, wait for its checks, then land`;
  }

  const checks = latestChecks(pr.checks);

  if (checks.length === 0) return `no check reported on ${name}'s head yet: wait for its run`;

  const running = checks.filter((check) => PENDING.has(check.state));

  if (running.length > 0) {
    return `checks still running on ${name}: ${running.map((check) => check.name).join(", ")}; wait with gh pr checks ${branch} --watch`;
  }

  const red = checks.filter((check) => !GREEN.has(check.state));

  if (red.length > 0) {
    return `checks not green on ${name}: ${red.map((check) => `${check.name} ${check.state.toLowerCase()}`).join(", ")}`;
  }

  return null;
}

/** Whether a push failed because the remote branch moved, as opposed to a hook or a rule. */
export function movedOn(pushError: string): boolean {
  return MOVED.test(pushError);
}

function touchesE2e(checkout: string): boolean {
  const diff = run(
    ["git", "diff", "--name-only", "--no-renames", "-z", `${REMOTE}/${DEV}`, "HEAD"],
    checkout,
  );

  return diff.out.split("\0").some((path) => path !== "" && isE2ePath(path));
}

type PullRequestRead =
  | { readonly kind: "read"; readonly pr: PullRequest }
  | { readonly kind: "unreadable"; readonly why: string };

function readPullRequest(branch: string, checkout: string): PullRequestRead {
  const view = run(
    [
      "gh",
      "pr",
      "view",
      branch,
      "--json",
      "number,state,baseRefName,headRefOid,statusCheckRollup",
      "--jq",
      PULL_REQUEST_JQ,
    ],
    checkout,
  );

  if (!view.ok)
    return { kind: "unreadable", why: `no pull request read for ${branch}: ${view.err}` };

  try {
    // SAFETY: the jq above prints exactly the fields of PullRequest, null where GitHub left one out,
    // and a pull request with a field missing can only fail to read as open, against dev and green.
    const pr: PullRequest = JSON.parse(view.out);

    return { kind: "read", pr };
  } catch {
    return { kind: "unreadable", why: `gh printed no pull request for ${branch}: ${view.out}` };
  }
}

export function land(branch: string, cwd: string): Landing {
  if (!LANDABLE.test(branch)) {
    return refused(`${branch} is not a feature/ or fix/ branch: only those land on ${DEV}`);
  }

  const worktrees = run(["git", "worktree", "list", "--porcelain"], cwd);

  if (!worktrees.ok) return refused(`git worktree list: ${worktrees.err}`);

  const checkout = checkoutOf(worktrees.out, branch);

  if (checkout === null) return refused(`no checkout holds ${branch}: check it out, then land`);

  const status = run(["git", "status", "--porcelain", "--untracked-files=no"], checkout);

  if (!status.ok) return refused(`git status in ${checkout}: ${status.err}`);

  if (status.out !== "") {
    return refused(`${checkout} has uncommitted changes: commit or drop them, then land`);
  }

  const reviewed = headOf(checkout);

  if (reviewed === null) return refused(`git rev-parse HEAD failed in ${checkout}`);

  const read = readPullRequest(branch, checkout);

  if (read.kind === "unreadable") return refused(read.why);

  const { pr } = read;
  const refusal = refusalOf(branch, pr, reviewed);

  if (refusal !== null) return refused(refusal);

  // The head the remote branch holds: the reviewed one, then each one this run pushed.
  let pushed = reviewed;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const fetched = run(["git", "fetch", "--quiet", REMOTE], checkout);

    if (!fetched.ok) return refused(`git fetch: ${fetched.err}`);

    const rebase = run(["git", "rebase", "--quiet", `${REMOTE}/${DEV}`], checkout);

    if (!rebase.ok) {
      run(["git", "rebase", "--abort"], checkout);

      return refused(
        `${branch} does not rebase cleanly on ${REMOTE}/${DEV}: rebase it by hand, push, then land\n${rebase.err}`,
      );
    }

    const rebased = headOf(checkout);

    if (rebased === null)
      return refused(`git rev-parse HEAD failed in ${checkout} after the rebase`);

    const branchPush = run(
      ["git", "push", "--quiet", `--force-with-lease=${branch}:${pushed}`, REMOTE, branch],
      checkout,
    );

    if (!branchPush.ok) {
      run(["git", "reset", "--quiet", "--hard", pushed], checkout);

      return refused(
        `the push of ${branch} was refused; it is back at ${short(pushed)}, the head ${REMOTE} holds:\n${branchPush.err}`,
      );
    }

    pushed = rebased;

    if (rebased !== pr.headRefOid && touchesE2e(checkout)) {
      return refused(
        `${branch} touches the e2e paths and the rebase made ${short(rebased)}, which needs its own e2e run: pushed it; now gh pr edit ${branch} --add-label e2e, wait for the run (docs/repo-ops/git.md), then land again`,
      );
    }

    const devPush = run(["git", "push", "--quiet", REMOTE, `${branch}:${DEV}`], checkout);

    if (devPush.ok) return { kind: "landed", dev: rebased, pr: pr.number };

    if (!movedOn(devPush.err)) {
      return refused(
        `pushed ${branch} at ${short(rebased)}, but the push to ${DEV} was refused; once its checks are green, land again:\n${devPush.err}`,
      );
    }
  }

  return refused(`${REMOTE}/${DEV} moved during each of ${ATTEMPTS} attempts: land again`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const [branch] = args;

  if (branch === undefined || args.length > 1) {
    console.error("Usage: bun ./scripts/land.ts <feature/...|fix/...>");
    process.exit(2);
  }

  const landing = land(branch, process.cwd());

  if (landing.kind === "landed") {
    console.log(`landed ${branch} on ${DEV} at ${short(landing.dev)} (#${landing.pr})`);
    console.log(`its run on ${DEV}: gh run list --branch ${DEV} --event push --limit 1`);
  } else {
    console.error(`land: ${landing.why}`);
    process.exitCode = 1;
  }
}
