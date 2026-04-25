#!/usr/bin/env bun

/**
 * PreToolUse hook for Bash — blocks git commit/push on protected branches.
 * Receives Claude Code tool JSON on stdin.
 *
 * Reuses stripStringLiterals from guard-destructive so that commit messages
 * describing branch mutations don't trigger false positives.
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
 *         "command": "bun _shared/claude-cli/hooks/guard-main-branch.ts",
 *         "timeout": 5
 *       }]
 *     }]
 *   }
 * }
 * ```
 */

import { HOOK_EXIT } from "../hooks.ts";
import { parseHookInput, stripStringLiterals } from "./guard-destructive.ts";

const PROTECTED_BRANCHES = ["main", "master"] as const;

const BRANCH_MUTATION_PATTERNS: ReadonlyArray<RegExp> = [
	/git\s+commit\b/,
	/git\s+push\b/,
	/git\s+merge\b/,
	/git\s+rebase\b/,
];

export function getCurrentBranch(cwd?: string): string | null {
	const result = Bun.spawnSync(["git", "symbolic-ref", "--short", "HEAD"], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) return null;
	return result.stdout.toString().trim();
}

export function getRepoRoot(cwd?: string): string | null {
	const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) return null;
	return result.stdout.toString().trim();
}

// Extract the target directory of a leading `cd <path> &&` (or `;`) clause.
// Returns null if no leading cd is present. Quoted paths are unquoted.
export function extractCdTarget(cmd: string): string | null {
	const m = cmd.match(
		/^\s*cd\s+("(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&]+)\s*(?:&&|;)/,
	);
	if (!m) return null;
	const raw = m[1] as string;
	if (
		(raw.startsWith('"') && raw.endsWith('"')) ||
		(raw.startsWith("'") && raw.endsWith("'"))
	) {
		return raw.slice(1, -1);
	}
	return raw;
}

export function isProtectedBranch(branch: string): boolean {
	return (PROTECTED_BRANCHES as readonly string[]).includes(branch);
}

export function isBranchMutatingCommand(cmd: string): boolean {
	const sanitized = stripStringLiterals(cmd);
	for (const pattern of BRANCH_MUTATION_PATTERNS) {
		if (pattern.test(sanitized)) return true;
	}
	return false;
}

export { parseHookInput };

if (import.meta.main) {
	if (process.env["MAIN_BYPASS"] === "1") process.exit(HOOK_EXIT.ALLOW);

	const input = await Bun.stdin.text();
	const cmd = parseHookInput(input);
	if (!cmd) process.exit(HOOK_EXIT.ALLOW);

	if (!isBranchMutatingCommand(cmd)) process.exit(HOOK_EXIT.ALLOW);

	// If the command targets a different repo via a leading `cd`, only enforce
	// when that repo is the same as the hook's project repo. Other repos have
	// their own conventions and aren't ours to police.
	const cdTarget = extractCdTarget(cmd);
	const effectiveCwd = cdTarget ?? undefined;
	if (cdTarget) {
		const targetRoot = getRepoRoot(cdTarget);
		const projectRoot = getRepoRoot();
		if (targetRoot && projectRoot && targetRoot !== projectRoot) {
			process.exit(HOOK_EXIT.ALLOW);
		}
	}

	const branch = getCurrentBranch(effectiveCwd);
	if (!branch || !isProtectedBranch(branch)) process.exit(HOOK_EXIT.ALLOW);

	console.error(`BLOCKED: '${branch}' is a protected branch.`);
	console.error("Work on 'dev' and merge via PR.");
	process.exit(HOOK_EXIT.BLOCK);
}
