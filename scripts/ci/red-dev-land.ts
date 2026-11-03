#!/usr/bin/env bun

/**
 * The `red-dev-land` workflow: the pull request the red-dev fix task opens from `fix/red-dev-<issue>`
 * lands on `dev` by itself once CI is green on its head and its review tier reads `low`. Each CI run
 * that completes wakes it; it goes on only for a green `pull_request` run of such a branch in this
 * repository whose head is still the open pull request's, to `dev`, not answered yet. Then
 * `scripts/landing/tier.ts` judges the change: `human` leaves a comment for a human to land it with
 * `land.ts`; `low` fast-forwards `dev` to the head when `dev` is its ancestor, and comments that `dev`
 * moved otherwise. It never creates a commit: `dev` requires signed commits, which the head's are.
 * Each comment is marked with the head, so a head is answered once.
 *
 * Reads `GITHUB_REPOSITORY` and the completed run's `RUN_EVENT`, `RUN_CONCLUSION`, `RUN_HEAD_BRANCH`,
 * `RUN_HEAD_SHA`, `RUN_HEAD_REPOSITORY`; calls `gh` and `git` with the job's token, and runs
 * `tier.ts` from the checkout, which is the default branch's, never the pull request's.
 */

import type { Env } from "../gates/affected.ts";

export const BRANCH = /^fix\/red-dev-\d+$/u;

const TRUNK = "dev";

const LAND = "bun ./scripts/land.ts";

/** The CI run that woke red-dev-land, as its `workflow_run` event names it. */
export interface Run {
  readonly event: string;
  readonly conclusion: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly headRepository: string;
}

export interface PullRequest {
  readonly number: number;
  readonly headSha: string;
  readonly base: string;
  readonly crossRepository: boolean;
  /** Each comment's body. */
  readonly texts: readonly string[];
}

export type Admission =
  | { readonly kind: "judge"; readonly pr: number; readonly sha: string }
  | { readonly kind: "none"; readonly reason: string };

export interface TierLine {
  readonly tier: "low" | "human";
  readonly reason: string;
}

export interface Judged {
  readonly pr: number;
  readonly sha: string;
  readonly tier: TierLine;
  readonly devIsAncestor: boolean;
}

export type Action =
  | { readonly kind: "push"; readonly pr: number; readonly sha: string; readonly comment: string }
  | { readonly kind: "comment"; readonly pr: number; readonly body: string };

export type Gh = (args: readonly string[]) => Promise<string>;

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type Git = (args: readonly string[]) => Promise<GitResult>;

/** `tier.ts`'s line for the pull request at that head. */
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

  if (pr.texts.some((text) => text.includes(markerOf(run.headSha)))) {
    return none(`#${pr.number} is answered already at ${run.headSha}`);
  }

  return { kind: "judge", pr: pr.number, sha: run.headSha };
}

/** `tier.ts`'s one line, `low|human <reason>`; anything else reads `human`, the safe direction. */
export function tierOf(output: string): TierLine {
  const line = output.trim();
  const match = /^(low|human) (.+)$/su.exec(line);

  if (match === null) return { tier: "human", reason: `tier.ts answered "${line}"` };

  return { tier: match[1] === "low" ? "low" : "human", reason: match[2] ?? "" };
}

export function decide(judged: Judged): Action {
  const { pr, sha, tier, devIsAncestor } = judged;
  const marker = markerOf(sha);

  if (tier.tier === "human") {
    return {
      kind: "comment",
      pr,
      body: `red-dev-land leaves ${sha} to a human: its tier is \`human\`, ${tier.reason}\n\nA human lands it with \`${LAND} <branch>\`.\n\n${marker}`,
    };
  }

  if (!devIsAncestor) {
    return {
      kind: "comment",
      pr,
      body: `red-dev-land does not land ${sha}: \`${TRUNK}\` moved, and is no ancestor of it, so the push would not be a fast-forward. Rebase the branch, or land it with \`${LAND} <branch>\`.\n\n${marker}`,
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
  comments: { body: string }[];
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
      "number,headRefOid,baseRefName,isCrossRepository,comments",
    ]),
  );

  return listed.map((pr) => ({
    number: pr.number,
    headSha: pr.headRefOid,
    base: pr.baseRefName,
    crossRepository: pr.isCrossRepository,
    texts: pr.comments.map((comment) => comment.body),
  }));
}

async function gitOk(git: Git, args: readonly string[]): Promise<void> {
  const result = await git(args);

  if (result.code !== 0) {
    throw new Error(`git ${args[0] ?? ""} exited ${result.code}: ${result.stderr.trim()}`);
  }
}

async function isAncestor(git: Git, ancestor: string, sha: string): Promise<boolean> {
  const args = ["merge-base", "--is-ancestor", ancestor, sha];
  const result = await git(args);

  if (result.code === 0) return true;

  if (result.code === 1) return false;

  throw new Error(`git merge-base exited ${result.code}: ${result.stderr.trim()}`);
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
  const remoteTrunk = `refs/remotes/origin/${TRUNK}`;

  await gitOk(git, ["fetch", "--no-tags", "origin", `+refs/heads/${TRUNK}:${remoteTrunk}`, sha]);

  const action = decide({
    pr,
    sha,
    tier: tierOf(await tier(pr, sha)),
    devIsAncestor: await isAncestor(git, remoteTrunk, sha),
  });

  switch (action.kind) {
    case "comment":
      await gh(["pr", "comment", String(pr), "--repo", repo, "--body", action.body]);

      return `commented on #${pr}`;
    case "push":
      await gitOk(git, ["push", "origin", `${action.sha}:refs/heads/${TRUNK}`]);
      await gh(["pr", "comment", String(pr), "--repo", repo, "--body", action.comment]);

      return `pushed ${action.sha} to ${TRUNK} for #${pr}`;
  }
}

async function spawned(argv: readonly string[]): Promise<GitResult> {
  const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { code, stdout, stderr };
}

async function ghCli(args: readonly string[]): Promise<string> {
  const result = await spawned(["gh", ...args]);

  if (result.code !== 0) {
    throw new Error(
      `gh ${args.slice(0, 2).join(" ")} exited ${result.code}: ${result.stderr.trim()}`,
    );
  }

  return result.stdout;
}

const gitCli: Git = (args) => spawned(["git", ...args]);

/** A crash of `tier.ts` answers `human` with its reason, as its own failures do. */
const tierCli: Tier = async (pr, sha) => {
  const result = await spawned([
    "bun",
    "./scripts/landing/tier.ts",
    "--pr",
    String(pr),
    "--head",
    sha,
  ]);

  return result.code === 0
    ? result.stdout
    : `human tier.ts exited ${result.code}: ${result.stderr.trim()}`;
};

if (import.meta.main) {
  console.log(`red-dev-land: ${await report(process.env, ghCli, gitCli, tierCli)}`);
}
