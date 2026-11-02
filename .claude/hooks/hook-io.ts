/**
 * Claude Code hook exit codes.
 * ALLOW (0): tool proceeds. ERROR (1): non-blocking, tool proceeds. BLOCK (2): tool is prevented.
 */
export const HOOK_EXIT = { ALLOW: 0, ERROR: 1, BLOCK: 2 } as const;

/**
 * Whether the hook runs in a Claude Code cloud session, which sets `CLAUDE_CODE_REMOTE=true`: a fresh clone with no
 * workstation behind it, where the SessionStart hooks of this repository find no main checkout to sweep, no private
 * repository to mount and no background run to start.
 */
export function inCloudSession(env: Readonly<Record<string, string | undefined>>): boolean {
  return env["CLAUDE_CODE_REMOTE"] === "true";
}
