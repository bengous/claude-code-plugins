#!/usr/bin/env bun

/**
 * PreToolUse hook for Bash — blocks destructive commands.
 * Receives Claude Code tool JSON on stdin.
 *
 * Strips quoted strings and heredocs before matching so that commit messages
 * or echo statements describing destructive commands don't trigger the guard.
 *
 * @usage
 * In .claude/settings.json:
 * ```json
 * {
 *   "hooks": {
 *     "PreToolUse": [{
 *       "matcher": "Bash",
 *       "hooks": [{
 *         "type": "command",
 *         "command": "bun .claude/hooks/guard-destructive.ts",
 *         "timeout": 5,
 *         "statusMessage": "Checking for destructive commands..."
 *       }]
 *     }]
 *   }
 * }
 * ```
 */

/**
 * Claude Code hook exit codes.
 * ALLOW (0): tool proceeds. ERROR (1): non-blocking, tool proceeds. BLOCK (2): tool is prevented.
 */
export const HOOK_EXIT = { ALLOW: 0, ERROR: 1, BLOCK: 2 } as const;

export interface HookInput {
  tool_input: {
    command: string;
  };
}

export const BLOCKED_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/rm\s+-rf\b/u, "rm -rf"],
  [/rm\s+-r\s+\//u, "rm -r /"],
  // (?![-\w]) keeps --force-with-lease/--force-if-includes out of the match:
  // the branch lanes require --force-with-lease on feature branches, and
  // guard-git-push.ts denies every force flavor that targets dev.
  [/git\s+push\s+--force(?![-\w])/u, "git push --force"],
  [/git\s+push\s+-f\b/u, "git push -f"],
  [/git\s+reset\s+--hard\b/u, "git reset --hard"],
  [/git\s+clean\s+-f/u, "git clean -f"],
  [/git\s+checkout\s+\.$/u, "git checkout ."],
  [/git\s+checkout\s+--\s+\.$/u, "git checkout -- ."],
  [/git\s+restore\s+\.$/u, "git restore ."],
  [/git\s+branch\s+-D\b/u, "git branch -D"],
];

export function stripStringLiterals(cmd: string): string {
  // Strip heredocs: <<'EOF' ... EOF, <<"EOF" ... EOF, <<EOF ... EOF
  let stripped = cmd.replaceAll(/<<-?\s*'?(\w+)'?.*?\n[\s\S]*?\n\s*\1/gu, "");
  // Strip double-quoted strings (non-greedy, respecting escapes)
  stripped = stripped.replaceAll(/"(?:[^"\\]|\\.)*"/gu, '""');
  // Strip single-quoted strings (no escapes in single quotes)
  stripped = stripped.replaceAll(/'[^']*'/gu, "''");
  return stripped;
}

export function checkCommand(cmd: string): string | null {
  const sanitized = stripStringLiterals(cmd);
  for (const [pattern, label] of BLOCKED_PATTERNS) {
    if (pattern.test(sanitized)) {
      return label;
    }
  }
  return null;
}

export function parseHookInput(raw: string): string | null {
  try {
    // SAFETY: shape is unchecked on purpose. Every read below is optional, and
    // a payload that does not match yields null, which the caller treats as
    // "nothing to block".
    const parsed = JSON.parse(raw) as HookInput;
    return parsed.tool_input?.command ?? null;
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const input = await Bun.stdin.text();
  const cmd = parseHookInput(input);
  if (!cmd) {
    process.exit(HOOK_EXIT.ALLOW);
  }

  const match = checkCommand(cmd);
  if (match) {
    console.error(`BLOCKED: destructive command detected: ${match}`);
    console.error(`Command: ${cmd}`);
    process.exit(HOOK_EXIT.BLOCK);
  }
}
