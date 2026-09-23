// Containment proofs: is a branch tip's content already in the base?

import { $ } from "bun";

import { git, gitRead, localRef, type Ref, remoteRef } from "./git.ts";

// How strongly we can prove a branch's content is already in the base:
//   ancestry       — the tip is reachable from base. Nothing is lost, history included.
//   no-merge-delta — merging it into base would change no file. Content is safe;
//                    the intermediate commits are not (squash/rebase/cherry-pick).
//   merged-pr      — GitHub merged this tip into the base through a pull request.
//                    Says nothing about whether the base still holds the content.
//   unproven       — the test did not conclude. NOT a proof of absence.
export type Proven = "ancestry" | "no-merge-delta" | "merged-pr";

export type ProofKind = Proven | "unproven";

// Exit 0 = ancestor, 1 = not, anything else = error (treated as "not proven").
export async function isAncestor(ref: Ref, of: Ref): Promise<boolean> {
  return (await git("merge-base", "--is-ancestor", ref, of)).exitCode === 0;
}

// Would merging `ref` into `base` change any file? Replaces the older
// commit-tree + `git cherry` patch-id test, which reported "contained" for a
// squash that was later reverted (patch-id only sees that the patch once
// landed, never that base still holds it).
async function hasNoMergeDelta(ref: Ref, base: Ref): Promise<boolean> {
  const merged = await git("merge-tree", "--write-tree", base, ref);

  // A conflict exits non-zero and still prints a tree — both checks are needed.
  if (merged.exitCode !== 0) return false;
  const baseTree = await git("rev-parse", `${base}^{tree}`);

  if (baseTree.exitCode !== 0) return false;

  return merged.stdout.split("\n")[0]?.trim() === baseTree.stdout;
}

// A squash or rebase merge that the base has since edited defeats both proofs
// above: the tip is no longer an ancestor and a three-way merge conflicts.
// GitHub still knows which pull requests carry that tip.
export type GithubProver = (ref: Ref) => Promise<boolean>;

type PullRef = { number: number; merged_at: string | null; base: { ref: string } };

const REVERTS_COMMIT = /This reverts commit ([0-9a-f]{40})/gu;

async function gh(...args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const { stdout, exitCode } = await $`gh ${args}`.quiet().nothrow();

  return { stdout: stdout.toString().trim(), exitCode };
}

/* oxlint-disable anti-slop/no-runtime-typeof -- this IS the boundary parser the rule asks for: it validates one entry of the GitHub REST payload before any proof reads it, and gh hands that payload over as text, so there is no earlier place to parse. */
function isPullRef(value: unknown): value is PullRef {
  if (typeof value !== "object" || value === null) return false;

  if (!("number" in value) || typeof value.number !== "number") return false;

  if (
    !("merged_at" in value) ||
    (value.merged_at !== null && typeof value.merged_at !== "string")
  ) {
    return false;
  }

  if (!("base" in value) || typeof value.base !== "object" || value.base === null) return false;

  return "ref" in value.base && typeof value.base.ref === "string";
}

/* oxlint-enable anti-slop/no-runtime-typeof -- end of the GitHub payload parser. */

// Any non-zero exit is "no signal", never an error: an unknown commit answers
// HTTP 422, and a missing or unauthenticated gh answers the same way.
async function pullsFor(repo: string, sha: string): Promise<PullRef[]> {
  const response = await gh("api", `repos/${repo}/commits/${sha}/pulls`);

  if (response.exitCode !== 0) return [];

  try {
    const parsed: unknown = JSON.parse(response.stdout);

    return Array.isArray(parsed) ? parsed.filter((entry) => isPullRef(entry)) : [];
  } catch {
    return [];
  }
}

// A merged pull request the base later reverted proves nothing. The revert is
// found by `git revert`'s own message, within the window that already bounds
// the containment test: a branch young enough to be tested has a younger revert.
async function revertedPullNumbers(
  repo: string,
  base: string,
  maxAgeDays: number,
): Promise<Set<number>> {
  const refs: Ref[] = [localRef(base)];
  const remoteBase = remoteRef(`origin/${base}`);

  if ((await git("rev-parse", "--verify", remoteBase)).exitCode === 0) refs.push(remoteBase);

  const reverted = new Set<number>();
  const log = await git("log", ...refs, `--since=${maxAgeDays} days ago`, "--format=%B");

  if (log.exitCode !== 0) return reverted;

  for (const [, sha] of log.stdout.matchAll(REVERTS_COMMIT)) {
    for (const pull of await pullsFor(repo, sha!)) reverted.add(pull.number);
  }

  return reverted;
}

// The repo probe and the revert scan run once, on the first still-unproven
// branch, and never again — a repo with nothing unproven pays nothing.
export function makeGithubProver(base: string, maxAgeDays: number): GithubProver {
  let context: Promise<{ repo: string; reverted: Set<number> } | null> | null = null;

  const resolveContext = async () => {
    // Same gate as the remote scan: no origin -> fully local, no network.
    if ((await git("remote", "get-url", "origin")).exitCode !== 0) return null;

    // gh resolves owner/repo from the remote itself, so ssh, https and
    // `insteadOf` rewrites all work with no URL parsing here. The charset of
    // the capture is also what makes the value safe in an API path.
    const view = await gh("repo", "view", "--json", "nameWithOwner");

    if (view.exitCode !== 0) return null;

    const repo = view.stdout.match(/"nameWithOwner"\s*:\s*"([\w.-]+\/[\w.-]+)"/u)?.[1];

    if (repo === undefined) return null;

    return { repo, reverted: await revertedPullNumbers(repo, base, maxAgeDays) };
  };

  return async (ref: Ref) => {
    context ??= resolveContext();
    const resolved = await context;

    if (resolved === null) return false;
    const tip = await git("rev-parse", ref);

    if (tip.exitCode !== 0) return false;

    return (await pullsFor(resolved.repo, tip.stdout)).some(
      (pull) =>
        pull.merged_at !== null && pull.base.ref === base && !resolved.reverted.has(pull.number),
    );
  };
}

export async function proveContained(
  ref: Ref,
  base: Ref,
  github: GithubProver | null,
): Promise<ProofKind> {
  if (await isAncestor(ref, base)) return "ancestry";

  if (await hasNoMergeDelta(ref, base)) return "no-merge-delta";

  if (github !== null && (await github(ref))) return "merged-pr";

  return "unproven";
}

// `git branch -d` refuses unless the tip is contained in the branch's upstream,
// or in HEAD when no upstream is set or its ref is gone. A branch fully merged
// into the base still fails when its remote counterpart has diverged — the
// audit predicts that here so the operation can carry a justified force flag
// instead of failing at apply. Returns what -d would measure against.
export async function predictDashDRefusal(branch: string): Promise<string | null> {
  const [upstream, upstreamShort] = (
    await gitRead("for-each-ref", "--format=%(upstream)%00%(upstream:short)", localRef(branch))
  ).split("\0");

  const upstreamResolves =
    upstream !== undefined &&
    upstream !== "" &&
    (await git("rev-parse", "--verify", "--quiet", upstream)).exitCode === 0;

  const [target, label] = upstreamResolves
    ? [upstream, upstreamShort ?? upstream]
    : ["HEAD", "HEAD"];

  const check = await git("merge-base", "--is-ancestor", localRef(branch), target);

  // Only a definite "not an ancestor" (exit 1) predicts refusal; an error leaves
  // the safe flag in place and lets `-d` speak for itself.
  return check.exitCode === 1 ? label : null;
}
