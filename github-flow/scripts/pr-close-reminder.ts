#!/usr/bin/env bun

/**
 * PostToolUse on Bash: after a `gh pr close`, reminds Claude that a pull request
 * integrated by squash, rebase or cherry-pick stays "closed" with nothing on it
 * to say where its work went. Claude Code runs PostToolUse only after a command
 * that succeeded, so a failed close never reaches this hook.
 */

import { $ } from "bun";

import { parsePayload } from "./plan-comment.ts";

const PR_CLOSE = /(?:^|[\s;|&])gh\s+pr\s+close(?:\s+|$)(.*)/su;

const PULL_URL_NUMBER = /\/pull\/(\d+)/u;

const BARE_NUMBER = /(?:^|\s)#?(\d+)(?:\s|$)/u;

const SEARCHED_REFS = ["origin/HEAD", "main", "HEAD"] as const;

/** The text after `gh pr close`, or null when the command closes no pull request. */
export function closeArguments(command: string): string | null {
  const match = command.match(PR_CLOSE);

  return match === null ? null : (match[1] ?? "");
}

/** The number in the arguments of `gh pr close`: a `/pull/12` URL first, then a bare `12` or `#12`. */
export function prNumber(args: string): number | null {
  const match = args.match(PULL_URL_NUMBER) ?? args.match(BARE_NUMBER);

  return match?.[1] === undefined ? null : Number(match[1]);
}

export interface Candidate {
  ref: string;
  sha: string;
}

export function reminder(pr: number | null, candidate: Candidate | null): string {
  const target = pr === null ? "the pull request it closed" : `#${pr}`;

  const lead =
    `gh pr close succeeded. A pull request integrated by squash, rebase or cherry-pick stays "closed" on GitHub, ` +
    `with nothing on it to say where its work went. If ${target} was integrated, comment on it with the SHA that ` +
    `integrated it, a summary of what landed (above all when several commits were squashed or rebased together), ` +
    `and, for anyone still on its branch, that its commits landed under other SHAs, so new work starts from the ` +
    `default branch.`;

  const found =
    pr === null
      ? ""
      : candidate === null
        ? ` No commit message names ${target} on ${SEARCHED_REFS.join(", ")}.`
        : ` Candidate: ${candidate.sha}, the newest commit on ${candidate.ref} whose message names ${target}.`;

  return (
    `${lead}${found} If it was abandoned, comment with why it was closed. ` +
    `A \`--comment\` on the close counts: add only what it left out.`
  );
}

/** The newest commit whose message names `#<pr>`, on the first searched ref that has one. */
export async function candidateSha(cwd: string, pr: number): Promise<Candidate | null> {
  const pattern = `(^|[^0-9])#${pr}([^0-9]|$)`;

  for (const ref of SEARCHED_REFS) {
    const { stdout, exitCode } = await $`git log -E --grep=${pattern} --format=%h -1 ${ref} --`
      .cwd(cwd)
      .quiet()
      .nothrow();

    const sha = stdout.toString().trim();

    if (exitCode === 0 && sha.length > 0) return { ref, sha };
  }

  return null;
}

if (import.meta.main) {
  try {
    const payload = parsePayload(await Bun.stdin.text());

    if (payload === null) process.exit(0);
    const args = closeArguments(payload.tool_input?.command ?? "");

    if (args === null) process.exit(0);
    const pr = prNumber(args);
    const candidate = pr === null ? null : await candidateSha(payload.cwd ?? process.cwd(), pr);

    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: reminder(pr, candidate),
        },
      }),
    );
  } catch (error) {
    console.error(`pr-close-reminder: ${error instanceof Error ? error.message : String(error)}`);
  }

  process.exit(0);
}
