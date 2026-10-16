/**
 * Claude Code hook exit codes.
 * ALLOW (0): tool proceeds. ERROR (1): non-blocking, tool proceeds. BLOCK (2): tool is prevented.
 */
export const HOOK_EXIT = { ALLOW: 0, ERROR: 1, BLOCK: 2 } as const;
