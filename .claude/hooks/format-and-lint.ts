#!/usr/bin/env bun

/**
 * PostToolUse hook for Edit|Write — formats the edited file with oxfmt, then
 * lints it with oxlint. Both read the repo-root config.
 *
 * Formatting is applied in place. A lint finding blocks (exit 2) so the finding
 * reaches the agent while the edit is still fresh.
 */

import { join } from "node:path";
import { HOOK_EXIT } from "./guard-destructive.ts";

export interface HookInput {
  tool_input: {
    file_path?: string;
  };
}

const LINTABLE_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs"] as const;

// Mirrors ignorePatterns in oxlint.config.ts and .oxfmtrc.json.
const SKIPPED_PREFIXES = [
  "archive/",
  "node_modules/",
  "tools/oxlint/anti-slop/",
  "claude-meta-tools/scripts/prompt-extractor/",
] as const;

export function parseFilePath(raw: string): string | null {
  try {
    // SAFETY: `file_path` is optional and read through `?.`, so a payload of
    // another shape returns null and the hook allows the edit.
    const parsed = JSON.parse(raw) as HookInput;
    return parsed.tool_input?.file_path ?? null;
  } catch {
    return null;
  }
}

/** Repo-relative path, or null when the file sits outside the repo. */
export function toRepoRelative(filePath: string, repoRoot: string): string | null {
  if (!filePath.startsWith("/")) return filePath;
  const prefix = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : null;
}

export function isLintable(relativePath: string): boolean {
  if (!LINTABLE_EXTENSIONS.some((ext) => relativePath.endsWith(ext))) return false;
  return !SKIPPED_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

async function runInRepo(repoRoot: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(args, { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: exitCode === 0, out: `${stdout}${stderr}`.trim() };
}

if (import.meta.main) {
  const repoRoot = process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd();
  const filePath = parseFilePath(await Bun.stdin.text());
  const relative = filePath === null ? null : toRepoRelative(filePath, repoRoot);

  if (relative === null || !isLintable(relative)) {
    process.exit(HOOK_EXIT.ALLOW);
  }
  if (!(await Bun.file(join(repoRoot, relative)).exists())) {
    process.exit(HOOK_EXIT.ALLOW);
  }

  await runInRepo(repoRoot, ["bun", "x", "oxfmt", relative]);
  const lint = await runInRepo(repoRoot, ["bun", "x", "oxlint", relative]);

  if (!lint.ok) {
    console.error(`oxlint rejected ${relative}:\n${lint.out}`);
    process.exit(HOOK_EXIT.BLOCK);
  }
}
