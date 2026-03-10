#!/usr/bin/env bun

/**
 * PostToolUse hook for Edit|Write — runs biome format+lint on edited files.
 * Receives Claude Code tool JSON on stdin.
 * Format errors are auto-fixed. Lint errors block (exit 2), warnings pass.
 *
 * Configuration: set LINT_SCOPE to a directory prefix to limit scope (default: "src/").
 * Set LINTABLE_EXTS to a comma-separated list of extensions (default: ".ts,.js,.mjs").
 *
 * @usage
 * In .claude/settings.json:
 * ```json
 * {
 *   "hooks": {
 *     "PostToolUse": [{
 *       "matcher": "Edit|Write",
 *       "hooks": [{
 *         "type": "command",
 *         "command": "bun .claude/hooks/format-and-lint.ts",
 *         "timeout": 30,
 *         "statusMessage": "Formatting and linting..."
 *       }]
 *     }]
 *   }
 * }
 * ```
 */

import { HOOK_EXIT } from "../hooks.ts";

export interface HookInput {
	tool_input: {
		file_path?: string;
	};
}

const DEFAULT_EXTENSIONS = [".ts", ".js", ".mjs"];
const DEFAULT_SCOPE = "src/";

export function parseFilePath(raw: string): string | null {
	try {
		const parsed = JSON.parse(raw) as HookInput;
		return parsed.tool_input?.file_path ?? null;
	} catch {
		return null;
	}
}

export function isLintable(
	filePath: string,
	extensions: ReadonlySet<string> = new Set(DEFAULT_EXTENSIONS),
	scope: string = DEFAULT_SCOPE,
): boolean {
	const ext = filePath.slice(filePath.lastIndexOf("."));
	if (!extensions.has(ext)) return false;
	const normalized = filePath.replace(/^\.\//, "");
	return normalized.startsWith(scope);
}

if (import.meta.main) {
	const lintScope = process.env["LINT_SCOPE"] ?? DEFAULT_SCOPE;
	const lintExts = new Set(
		process.env["LINTABLE_EXTS"]?.split(",") ?? DEFAULT_EXTENSIONS,
	);

	const input = await Bun.stdin.text();
	const filePath = parseFilePath(input);

	if (!filePath || !isLintable(filePath, lintExts, lintScope)) {
		process.exit(HOOK_EXIT.ALLOW);
	}

	// Format with auto-fix — never block on format errors
	Bun.spawnSync(
		["./node_modules/.bin/biome", "format", "--write", filePath],
		{ stdout: "ignore", stderr: "ignore" },
	);

	// Lint — block on errors only (not warnings)
	const lint = Bun.spawnSync(
		["./node_modules/.bin/biome", "lint", "--diagnostic-level=error", filePath],
		{ stdout: "pipe", stderr: "pipe" },
	);

	if (lint.exitCode !== 0) {
		const stderr = lint.stderr.toString();
		const stdout = lint.stdout.toString();
		if (stderr) console.error(stderr);
		if (stdout) console.error(stdout);
		process.exit(HOOK_EXIT.BLOCK);
	}
}
