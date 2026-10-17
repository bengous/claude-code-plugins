#!/usr/bin/env bun

/**
 * A clean review verdict bound to the change it judged: `scripts/land.ts` lands a
 * branch that touches a path of `profile.review.risky` (`.claude/agent-hooks.jsonc`)
 * only when its pull request carries one for its patch (docs/repo-ops/git.md).
 *
 *   bun ./scripts/review-verdict.ts record <branch> --sha <reviewed head>
 *
 * Refused unless `<reviewed head>` is the pull request's head, so a push after
 * the review gets no verdict. Posts on the pull request a comment whose first
 * line is `<!-- review: clean patch-id=<id> -->`, the `git patch-id --verbatim`
 * of the diff from the head's merge-base with `origin/dev` to the head:
 * whitespace counts, line numbers do not. A rebase that leaves that diff as it
 * was keeps the verdict; a commit after the review does not, nor a rebase that
 * changes the lines around a hunk.
 */

import { parseArgs } from "node:util";

import { run } from "./lib/run.ts";

export const REMOTE = "origin";

export const DEV = "dev";

export const BASE = `${REMOTE}/${DEV}`;

const VERDICT = /^<!-- review: clean patch-id=([0-9a-f]{40}) -->$/u;

/** GitHub's `authorAssociation` of the accounts that can push to the repository. */
const WRITERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** One comment as `gh pr view --json comments` prints it, the fields read here. */
export interface Comment {
  readonly body: string;
  readonly authorAssociation: string;
}

export type PatchId =
  | { readonly kind: "read"; readonly id: string }
  | { readonly kind: "failed"; readonly why: string };

export type Recording =
  | { readonly kind: "recorded"; readonly pr: number; readonly patchId: string }
  | { readonly kind: "refused"; readonly why: string };

export function short(commit: string): string {
  return commit.slice(0, 8);
}

export function verdictLine(patchId: string): string {
  return `<!-- review: clean patch-id=${patchId} -->`;
}

/** The command that records a verdict for `branch` reviewed at `sha`, a commit or a placeholder for one. */
export function recordCommand(branch: string, sha: string): string {
  return `bun ./scripts/review-verdict.ts record ${branch} --sha ${sha}`;
}

/** The patch-ids clean review verdicts were posted for, by someone who can push. */
export function verdictsOf(comments: readonly Comment[]): ReadonlySet<string> {
  const ids = new Set<string>();

  for (const comment of comments) {
    const [first = ""] = comment.body.split(/\r?\n/u, 1);
    const id = VERDICT.exec(first.trim())?.[1];

    if (id !== undefined && WRITERS.has(comment.authorAssociation)) ids.add(id);
  }

  return ids;
}

/** The patch-id of what `head` changes since its merge-base with `base`. */
export function patchIdOf(cwd: string, base: string, head: string): PatchId {
  const mergeBase = run(["git", "merge-base", base, head], cwd);

  if (!mergeBase.ok) {
    return { kind: "failed", why: `git merge-base ${base} ${short(head)}: ${mergeBase.err}` };
  }

  // Plumbing, not `git diff`: the user's diff config (color, renames, textconv, prefixes) cannot change the patch.
  const diff = run(["git", "diff-tree", "-p", "--binary", mergeBase.out, head], cwd);

  if (!diff.ok) return { kind: "failed", why: `git diff-tree ${short(head)}: ${diff.err}` };

  const patchId = run(["git", "patch-id", "--verbatim"], cwd, diff.raw);
  const [id = ""] = patchId.out.split(" ");

  if (!patchId.ok || id === "") {
    return { kind: "failed", why: `${short(head)} changes nothing since ${base}` };
  }

  return { kind: "read", id };
}

/** Posts on `branch`'s pull request the clean review verdict for its head, refused unless that head is `sha`. */
export function record(branch: string, sha: string, cwd: string): Recording {
  const view = run(["gh", "pr", "view", branch, "--json", "number,headRefOid"], cwd);

  if (!view.ok) return { kind: "refused", why: `no pull request read for ${branch}: ${view.err}` };

  let pr: { readonly number: number; readonly headRefOid: string };

  try {
    // SAFETY: gh prints exactly the fields asked for.
    pr = JSON.parse(view.out);
  } catch {
    return { kind: "refused", why: `gh printed no pull request for ${branch}: ${view.out}` };
  }

  const fetched = run(["git", "fetch", "--quiet", REMOTE], cwd);

  if (!fetched.ok) return { kind: "refused", why: `git fetch: ${fetched.err}` };

  const reviewed = run(["git", "rev-parse", "--verify", "--quiet", `${sha}^{commit}`], cwd);

  if (!reviewed.ok || reviewed.out !== pr.headRefOid) {
    return {
      kind: "refused",
      why: `the head of #${pr.number} is ${short(pr.headRefOid)}, not ${short(sha)}: review that head, then record it`,
    };
  }

  const patchId = patchIdOf(cwd, BASE, pr.headRefOid);

  if (patchId.kind === "failed") return { kind: "refused", why: patchId.why };

  const body = [
    verdictLine(patchId.id),
    `A review of ${short(pr.headRefOid)} left no finding open. \`scripts/land.ts\` lands this change while its patch against \`${BASE}\` stays the same.`,
    "",
  ].join("\n");

  const posted = run(
    ["gh", "pr", "comment", String(pr.number), "--body-file", "-"],
    cwd,
    Buffer.from(body),
  );

  if (!posted.ok) return { kind: "refused", why: `gh pr comment ${pr.number}: ${posted.err}` };

  return { kind: "recorded", pr: pr.number, patchId: patchId.id };
}

if (import.meta.main) {
  const usage = "Usage: bun ./scripts/review-verdict.ts record <branch> --sha <reviewed head>";
  let parsed;

  try {
    parsed = parseArgs({ options: { sha: { type: "string" } }, allowPositionals: true });
  } catch {
    console.error(usage);
    process.exit(2);
  }

  const [command, branch, ...rest] = parsed.positionals;
  const { sha } = parsed.values;

  if (command !== "record" || branch === undefined || sha === undefined || rest.length > 0) {
    console.error(usage);
    process.exit(2);
  }

  const recording = record(branch, sha, process.cwd());

  if (recording.kind === "recorded") {
    console.log(
      `recorded a clean review of ${branch} on #${recording.pr}: patch-id ${short(recording.patchId)}`,
    );
  } else {
    console.error(`review-verdict: ${recording.why}`);
    process.exitCode = 1;
  }
}
