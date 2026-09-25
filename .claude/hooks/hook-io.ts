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

export function stripStringLiterals(cmd: string): string {
  // Strip heredocs: <<'EOF' ... EOF, <<"EOF" ... EOF, <<EOF ... EOF
  let stripped = cmd.replaceAll(/<<-?\s*'?(\w+)'?.*?\n[\s\S]*?\n\s*\1/gu, "");
  // Strip double-quoted strings (non-greedy, respecting escapes)
  stripped = stripped.replaceAll(/"(?:[^"\\]|\\.)*"/gu, '""');
  // Strip single-quoted strings (no escapes in single quotes)
  stripped = stripped.replaceAll(/'[^']*'/gu, "''");

  return stripped;
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
