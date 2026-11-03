#!/usr/bin/env bun

/**
 * The `red-dev-land` workflow: the pull request the red-dev fix task opens from `fix/red-dev-<issue>`
 * lands on `dev` by itself once CI is green on its head and its review tier reads `low`. Each CI run
 * that completes wakes it; it goes on only for a green `pull_request` run of such a branch in this
 * repository whose head is still the open, ready pull request's, to `dev`, not answered yet. A head
 * on `dev` already changes nothing. A head `dev` is no ancestor of, or one that touches the e2e
 * paths (`scripts/gates/check-e2e-green.ts`), gets a comment for a human. Then
 * `scripts/landing/tier.ts` judges the change: `human` leaves a comment for a human to land it with
 * `land.ts`; `low` fast-forwards `dev` to the head. It never creates a commit: `dev` requires signed
 * commits, which the head's are. Each comment is marked with the head, and a marker counts only in
 * the App's own comments, so a head is answered once.
 *
 * Reads `GITHUB_REPOSITORY` and the completed run's `RUN_EVENT`, `RUN_CONCLUSION`, `RUN_HEAD_BRANCH`,
 * `RUN_HEAD_SHA`, `RUN_HEAD_REPOSITORY`; calls `gh` and `git` with the job's token, and runs
 * `tier.ts` from the checkout, which is the default branch's, never the pull request's.
 */

import { type GitResult, GitError, git as gitCli } from "../../tools/platform/git.ts";
import { run as runProcess } from "../../tools/platform/process.ts";
import type { Env } from "../gates/affected.ts";
import { isE2ePath } from "../gates/check-e2e-green.ts";

export const BRANCH = /^fix\/red-dev-\d+$/u;

/** The login, on GitHub's REST API, of the App whose token the workflow acts with. */
export const APP_LOGIN = "bengous-agents[bot]";

const TRUNK = "dev";

const REMOTE_TRUNK = `refs/remotes/origin/${TRUNK}`;

const LAND = "bun ./scripts/land.ts";

/** The CI run that woke red-dev-land, as its `workflow_run` event names it. */
export interface Run {
  readonly event: string;
  readonly conclusion: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly headRepository: string;
}

export interface Comment {
  readonly login: string;
  readonly body: string;
}

export interface PullRequest {
  readonly number: number;
  readonly headSha: string;
  readonly base: string;
  readonly crossRepository: boolean;
  readonly draft: boolean;
  readonly comments: readonly Comment[];
}

export type Admission =
  | { readonly kind: "judge"; readonly pr: number; readonly sha: string }
  | { readonly kind: "none"; readonly reason: string };

export interface TierLine {
  readonly tier: "low" | "human";
  readonly reason: string;
}

/** What git says of the head against `dev`, read before any tier is asked. */
export interface Placed {
  readonly pr: number;
  readonly sha: string;
  readonly devSha: string;
  readonly devIsAncestor: boolean;
  /** The paths `origin/dev...<sha>` changes. */
  readonly paths: readonly string[];
}

export type Action =
  | { readonly kind: "push"; readonly pr: number; readonly sha: string; readonly comment: string }
  | { readonly kind: "comment"; readonly pr: number; readonly body: string }
  | { readonly kind: "none"; readonly reason: string };

export type Gh = (args: readonly string[]) => Promise<string>;

export type Git = (args: readonly string[]) => Promise<GitResult>;

/** `tier.ts`'s line for the pull request at that head; a crash throws. */
export type Tier = (pr: number, sha: string) => Promise<string>;

/** The line each answer to `sha` carries, so a head is answered once. */
export function markerOf(sha: string): string {
  return `<!-- red-dev-land:${sha} -->`;
}

const none = (reason: string): Admission => ({ kind: "none", reason });

/** Whether the completed run is a green fix of red-dev's that red-dev-land has still to judge. */
export function admit(repo: string, run: Run, prs: readonly PullRequest[]): Admission {
  if (run.event !== "pull_request")
    return none(`the run's event is ${run.event}, not pull_request`);

  if (!BRANCH.test(run.headBranch)) {
    return none(`the run's branch ${run.headBranch} is no fix/red-dev-<issue>`);
  }

  if (run.headRepository !== repo) {
    return none(`the run's head is in ${run.headRepository}, not in ${repo}`);
  }

  if (run.conclusion !== "success") {
    return none(`the run on ${run.headBranch} ended ${run.conclusion}, not success`);
  }

  const pr = prs.find((found) => !found.crossRepository);

  if (pr === undefined) return none(`no open pull request comes from ${run.headBranch} in ${repo}`);

  if (pr.headSha !== run.headSha) {
    return none(`#${pr.number}'s head is ${pr.headSha}, no longer the run's ${run.headSha}`);
  }

  if (pr.base !== TRUNK) return none(`#${pr.number} targets ${pr.base}, not ${TRUNK}`);

  if (pr.draft) return none(`#${pr.number} is a draft`);

  const answered = pr.comments.some(
    (comment) => comment.login === APP_LOGIN && comment.body.includes(markerOf(run.headSha)),
  );

  if (answered) return none(`#${pr.number} is answered already at ${run.headSha}`);

  return { kind: "judge", pr: pr.number, sha: run.headSha };
}

/** `tier.ts`'s one line, `low|human <reason>`; anything else reads `human`, the safe direction. */
export function tierOf(output: string): TierLine {
  const line = output.trim();
  const match = /^(low|human) (.+)$/su.exec(line);

  if (match === null) return { tier: "human", reason: `tier.ts answered "${line}"` };

  return { tier: match[1] === "low" ? "low" : "human", reason: match[2] ?? "" };
}

/** What git alone settles, before the tier is asked; `null` asks it. */
export function place(placed: Placed): Action | null {
  const { pr, sha, devSha, devIsAncestor, paths } = placed;
  const marker = markerOf(sha);

  if (devSha === sha) return { kind: "none", reason: `${sha} is on ${TRUNK} already` };

  if (!devIsAncestor) {
    return {
      kind: "comment",
      pr,
      body: `red-dev-land does not land ${sha}: \`${TRUNK}\` moved, and is no ancestor of it, so the push would not be a fast-forward. Rebase the branch, or land it with \`${LAND} <branch>\`.\n\n${marker}`,
    };
  }

  const e2e = paths.find((path) => isE2ePath(path));

  if (e2e !== undefined) {
    return {
      kind: "comment",
      pr,
      body: `red-dev-land leaves ${sha} to a human: it touches the e2e paths (\`${e2e}\`), which reach \`${TRUNK}\` only with a green \`e2e\` run. A human adds the \`e2e\` label, then lands it with \`${LAND} <branch>\`.\n\n${marker}`,
    };
  }

  return null;
}

export function decide(pr: number, sha: string, tier: TierLine): Action {
  const marker = markerOf(sha);

  if (tier.tier === "human") {
    return {
      kind: "comment",
      pr,
      body: `red-dev-land leaves ${sha} to a human: its tier is \`human\`, ${tier.reason}\n\nA human lands it with \`${LAND} <branch>\`.\n\n${marker}`,
    };
  }

  return {
    kind: "push",
    pr,
    sha,
    comment: `red-dev-land pushed ${sha} to \`${TRUNK}\`, a fast-forward: its tier is \`low\`, ${tier.reason}\n\n${marker}`,
  };
}

function required(env: Env, name: string): string {
  const value = env[name];

  if (value === undefined || value === "") throw new Error(`${name} is unset`);

  return value;
}

interface PullRequestJson {
  number: number;
  headRefOid: string;
  baseRefName: string;
  isCrossRepository: boolean;
  isDraft: boolean;
}

interface CommentJson {
  login: string;
  body: string;
}

/** A pull request's comments through the REST API, where an App's login ends with `[bot]`. */
async function commentsOf(gh: Gh, repo: string, pr: number): Promise<Comment[]> {
  const lines = await gh([
    "api",
    "--paginate",
    `repos/${repo}/issues/${pr}/comments?per_page=100`,
    "--jq",
    ".[] | {login: .user.login, body}",
  ]);

  return lines
    .split("\n")
    .filter((line) => line !== "")
    .map((line): CommentJson => JSON.parse(line));
}

async function openPullRequests(gh: Gh, repo: string, branch: string): Promise<PullRequest[]> {
  const listed: PullRequestJson[] = JSON.parse(
    await gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number,headRefOid,baseRefName,isCrossRepository,isDraft",
    ]),
  );

  return Promise.all(
    listed.map(async (pr) => ({
      number: pr.number,
      headSha: pr.headRefOid,
      base: pr.baseRefName,
      crossRepository: pr.isCrossRepository,
      draft: pr.isDraft,
      comments: pr.isCrossRepository ? [] : await commentsOf(gh, repo, pr.number),
    })),
  );
}

async function gitRead(git: Git, args: readonly string[]): Promise<string> {
  const result = await git(args);

  if (result.kind !== "exited" || result.code !== 0) throw new GitError(args, result);

  return result.stdout;
}

async function isAncestor(git: Git, ancestor: string, sha: string): Promise<boolean> {
  const args = ["merge-base", "--is-ancestor", ancestor, sha];
  const result = await git(args);

  if (result.kind === "exited" && result.code === 0) return true;

  if (result.kind === "exited" && result.code === 1) return false;

  throw new GitError(args, result);
}

async function placedOf(git: Git, pr: number, sha: string): Promise<Placed> {
  await gitRead(git, ["fetch", "--no-tags", "origin", `+refs/heads/${TRUNK}:${REMOTE_TRUNK}`, sha]);

  return {
    pr,
    sha,
    devSha: (await gitRead(git, ["rev-parse", REMOTE_TRUNK])).trim(),
    devIsAncestor: await isAncestor(git, REMOTE_TRUNK, sha),
    paths: (await gitRead(git, ["diff", "--name-only", "-z", `${REMOTE_TRUNK}...${sha}`]))
      .split("\0")
      .filter((path) => path !== ""),
  };
}

/** Reads the run and its pull request, judges the head, does what that settles, and says what it did. */
export async function report(env: Env, gh: Gh, git: Git, tier: Tier): Promise<string> {
  const repo = required(env, "GITHUB_REPOSITORY");

  const run: Run = {
    event: required(env, "RUN_EVENT"),
    conclusion: required(env, "RUN_CONCLUSION"),
    headBranch: required(env, "RUN_HEAD_BRANCH"),
    headSha: required(env, "RUN_HEAD_SHA"),
    headRepository: required(env, "RUN_HEAD_REPOSITORY"),
  };

  const prs =
    run.event === "pull_request" && BRANCH.test(run.headBranch)
      ? await openPullRequests(gh, repo, run.headBranch)
      : [];

  const admission = admit(repo, run, prs);

  if (admission.kind === "none") return admission.reason;

  const { pr, sha } = admission;

  const action =
    place(await placedOf(git, pr, sha)) ?? decide(pr, sha, tierOf(await tier(pr, sha)));

  switch (action.kind) {
    case "none":
      return action.reason;
    case "comment":
      await gh(["pr", "comment", String(pr), "--repo", repo, "--body", action.body]);

      return `commented on #${pr}`;
    case "push":
      await gitRead(git, ["push", "origin", `${action.sha}:refs/heads/${TRUNK}`]);
      await gh(["pr", "comment", String(pr), "--repo", repo, "--body", action.comment]);

      return `pushed ${action.sha} to ${TRUNK} for #${pr}`;
  }
}

/** Runs `argv` to its end; anything but an exit 0 throws, with what it printed. */
async function checked(argv: readonly [string, ...string[]]): Promise<string> {
  const result = await runProcess(argv);
  const name = argv.slice(0, 3).join(" ");

  if (result.kind === "missing") throw new Error(`${result.program} is not on the PATH`);

  if (result.kind === "timedOut") throw new Error(`${name} timed out: ${result.stderr.trim()}`);

  if (result.code !== 0) throw new Error(`${name} exited ${result.code}: ${result.stderr.trim()}`);

  return result.stdout;
}

const ghCli: Gh = (args) => checked(["gh", ...args]);

/** A crash of `tier.ts` throws: a transient failure leaves no marked answer behind. */
const tierCli: Tier = (pr, sha) =>
  checked(["bun", "./scripts/landing/tier.ts", "--pr", String(pr), "--head", sha]);

if (import.meta.main) {
  console.log(`red-dev-land: ${await report(process.env, ghCli, (args) => gitCli(args), tierCli)}`);
}
