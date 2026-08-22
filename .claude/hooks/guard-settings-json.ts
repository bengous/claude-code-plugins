#!/usr/bin/env bun

/**
 * PreToolUse hook for Edit|Write|Bash — blocks direct writes to
 * .claude/settings.json, which is generated from .claude/__settings.jsonc.
 * Receives Claude Code tool JSON on stdin.
 *
 * The pre-commit job `block-settings-json` is the authority: it catches every
 * writer, including editors and scripts this hook never sees. This hook only
 * moves the failure earlier, so an edit is corrected at the keystroke instead
 * of at commit time.
 *
 * The Bash arm is best-effort. Shell redirection, `sed -i`, `tee` and `mv`
 * are matched; an inline python/node script writing the same file is not.
 *
 * @usage
 * In .claude/__settings.jsonc:
 * ```json
 * {
 *   "hooks": {
 *     "PreToolUse": [{
 *       "matcher": "Edit|Write|Bash",
 *       "hooks": [{
 *         "type": "command",
 *         "command": "bun \"$CLAUDE_PROJECT_DIR/.claude/hooks/guard-settings-json.ts\"",
 *         "timeout": 5
 *       }]
 *     }]
 *   }
 * }
 * ```
 */

import { isAbsolute, resolve } from "node:path";

/**
 * Claude Code hook exit codes.
 * ALLOW (0): tool proceeds. ERROR (1): non-blocking, tool proceeds. BLOCK (2): tool is prevented.
 */
export const HOOK_EXIT = { ALLOW: 0, ERROR: 1, BLOCK: 2 } as const;

export const GUARDED_PATH = ".claude/settings.json";
export const SOURCE_PATH = ".claude/__settings.jsonc";

export interface HookInput {
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    command?: string;
  };
}

// Matches the guarded path only when it ends there, so `.claude/settings.json.tmp`
// — the staging file settings-sync.sh writes — is left alone.
const GUARDED_PATTERN = String.raw`(?:\./)?\.claude/settings\.json(?![\w.\-/])`;

export const WRITE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [new RegExp(String.raw`>>?\s*['"]?${GUARDED_PATTERN}`), "shell redirection"],
  [new RegExp(String.raw`\bsed\b[^|;&]*-i\b[^|;&]*${GUARDED_PATTERN}`), "sed -i"],
  [new RegExp(String.raw`\btee\b[^|;&]*${GUARDED_PATTERN}`), "tee"],
  [
    new RegExp(
      String.raw`\b(?:mv|cp|install)\b[^|;&]*\s['"]?${GUARDED_PATTERN}['"]?\s*(?:$|[|;&])`,
    ),
    "mv/cp into the file",
  ],
  [new RegExp(String.raw`\btruncate\b[^|;&]*${GUARDED_PATTERN}`), "truncate"],
];

export function parseHookInput(raw: string): HookInput | null {
  try {
    return JSON.parse(raw) as HookInput;
  } catch {
    return null;
  }
}

export function projectDir(env: Record<string, string | undefined>): string {
  const dir = env["CLAUDE_PROJECT_DIR"];
  return dir && isAbsolute(dir) ? dir : process.cwd();
}

export function isGuardedFile(filePath: string, root: string): boolean {
  return resolve(root, filePath) === resolve(root, GUARDED_PATH);
}

export function checkCommand(cmd: string): string | null {
  for (const [pattern, label] of WRITE_PATTERNS) {
    if (pattern.test(cmd)) return label;
  }
  return null;
}

export function blockMessage(how: string): string {
  return [
    `BLOCKED: ${GUARDED_PATH} is generated — direct writes are not allowed (${how}).`,
    `Edit ${SOURCE_PATH} instead (it supports comments).`,
    "The pre-commit sync regenerates the JSON, or run ./.claude/scripts/settings-sync.sh.",
  ].join("\n");
}

if (import.meta.main) {
  if (process.env["SETTINGS_BYPASS"] === "1") process.exit(HOOK_EXIT.ALLOW);

  const input = parseHookInput(await Bun.stdin.text());
  if (!input) process.exit(HOOK_EXIT.ALLOW);

  const root = projectDir(process.env);
  const { file_path: filePath, command } = input.tool_input ?? {};

  if (filePath && isGuardedFile(filePath, root)) {
    console.error(blockMessage(`${input.tool_name ?? "Edit"} tool`));
    process.exit(HOOK_EXIT.BLOCK);
  }

  if (command) {
    const how = checkCommand(command);
    if (how) {
      console.error(blockMessage(how));
      process.exit(HOOK_EXIT.BLOCK);
    }
  }
}
