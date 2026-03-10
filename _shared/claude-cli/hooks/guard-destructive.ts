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

import { HOOK_EXIT } from "../hooks.ts";

export interface HookInput {
	tool_input: {
		command: string;
	};
}

export const BLOCKED_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	[/rm\s+-rf\b/, "rm -rf"],
	[/rm\s+-r\s+\//, "rm -r /"],
	[/git\s+push\s+--force\b/, "git push --force"],
	[/git\s+push\s+-f\b/, "git push -f"],
	[/git\s+reset\s+--hard\b/, "git reset --hard"],
	[/git\s+clean\s+-f/, "git clean -f"],
	[/git\s+checkout\s+\.$/, "git checkout ."],
	[/git\s+checkout\s+--\s+\.$/, "git checkout -- ."],
	[/git\s+restore\s+\.$/, "git restore ."],
	[/git\s+branch\s+-D\b/, "git branch -D"],
];

export function stripStringLiterals(cmd: string): string {
	// Strip heredocs: <<'EOF' ... EOF, <<"EOF" ... EOF, <<EOF ... EOF
	let stripped = cmd.replace(
		/<<-?\s*'?(\w+)'?.*?\n[\s\S]*?\n\s*\1/g,
		"",
	);
	// Strip double-quoted strings (non-greedy, respecting escapes)
	stripped = stripped.replace(/"(?:[^"\\]|\\.)*"/g, '""');
	// Strip single-quoted strings (no escapes in single quotes)
	stripped = stripped.replace(/'[^']*'/g, "''");
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
