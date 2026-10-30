#!/usr/bin/env bun

/**
 * PreToolUse on Bash: denies a `gh pr close` that leaves no closing comment.
 * GitHub links a closed pull request to no commit, so the comment is the only
 * record of where its work went or why it was dropped. The command is matched
 * as one string: a `gh pr close` written as text is denied too, which costs
 * Claude one retry, and in a chain of closes one comment lets them all through.
 * Any failure lets the call through.
 */

import { parsePayload } from "./plan-comment.ts";

export const DENY_REASON = [
  "gh pr close needs a non-empty --comment (-c), for each pull request it closes.",
  "GitHub links a closed pull request to no commit, so this comment is the only",
  "record of what became of it:",
  "- integrated: the base-branch commits that carry it, a summary of what landed,",
  "  and that its branch's commits landed under other SHAs;",
  "- abandoned: the reason.",
].join("\n");

const PR_CLOSE = /\bgh\s+pr\s+(?:(?:-R|--repo)[=\s]\S+\s+)?close\b/u;

const COMMENT = /(?:^|\s)(?:-c|--comment)(?:=|\s+)(?:"[^"]*\S[^"]*"|'[^']*\S[^']*'|[^\s"'-])/u;

export function closesWithoutComment(command: string): boolean {
  return PR_CLOSE.test(command) && !COMMENT.test(command);
}

if (import.meta.main) {
  const command = parsePayload(await Bun.stdin.text())?.tool_input?.command;

  if (command !== undefined && closesWithoutComment(command)) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: DENY_REASON,
        },
      }),
    );
  }

  process.exit(0);
}
