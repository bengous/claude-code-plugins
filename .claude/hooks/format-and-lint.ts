#!/usr/bin/env bun

/**
 * PostToolUse hook for Edit|Write — runs biome format+lint on edited files.
 * Receives Claude Code tool JSON on stdin.
 * Format errors are auto-fixed. Lint errors block (exit 2), warnings pass.
 */

import { HOOK_EXIT } from "./guard-destructive.ts";

export interface HookInput {
	tool_input: {
		file_path?: string;
	};
}

const LINTABLE_EXTENSIONS = new Set([".ts", ".js", ".mjs"]);

export function parseFilePath(raw: string): string | null {
	try {
		const parsed = JSON.parse(raw) as HookInput;
		return parsed.tool_input?.file_path ?? null;
	} catch {
		return null;
	}
}

// FIXME: hardcoded path — this hook is repo-specific to claude-plugins.
// Biome config lives inside _hooks-lib/ so we need to know where it is.
// Will be replaced by a configurable path when hooks move to the framework.
const HOOKS_LIB_DIR = "_hooks-lib";

function toRelative(filePath: string): string {
	const cwd = process.cwd();
	if (filePath.startsWith(cwd)) {
		return filePath.slice(cwd.length + 1);
	}
	return filePath.replace(/^\.\//, "");
}

export function isLintable(filePath: string): boolean {
	const ext = filePath.slice(filePath.lastIndexOf("."));
	if (!LINTABLE_EXTENSIONS.has(ext)) return false;
	const rel = toRelative(filePath);
	return rel.startsWith(`${HOOKS_LIB_DIR}/src/`);
}

if (import.meta.main) {
	const input = await Bun.stdin.text();
	const filePath = parseFilePath(input);

	if (!filePath || !isLintable(filePath)) {
		process.exit(HOOK_EXIT.ALLOW);
	}

	// biome includes are relative to config dir, so cd into _hooks-lib
	// and pass the path relative to that directory
	const rel = toRelative(filePath);
	const relativePath = rel.slice(HOOKS_LIB_DIR.length + 1);
	const biome = "./node_modules/.bin/biome";
	const cwd = HOOKS_LIB_DIR;

	// Check (format + organizeImports + lint) with auto-fix
	Bun.spawnSync([biome, "check", "--write", relativePath], {
		cwd,
		stdout: "ignore",
		stderr: "ignore",
	});

	// Re-lint to block on unfixable errors only
	const lint = Bun.spawnSync(
		[biome, "lint", "--diagnostic-level=error", relativePath],
		{ cwd, stdout: "pipe", stderr: "pipe" },
	);

	if (lint.exitCode !== 0) {
		const stderr = lint.stderr.toString();
		const stdout = lint.stdout.toString();
		if (stderr) console.error(stderr);
		if (stdout) console.error(stdout);
		process.exit(HOOK_EXIT.BLOCK);
	}
}
