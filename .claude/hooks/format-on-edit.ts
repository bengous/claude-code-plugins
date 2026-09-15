#!/usr/bin/env bun

/**
 * PostToolUse hook for Edit|Write — applies oxlint's safe fixes and formats
 * the edited file with oxfmt, or formats it with shfmt, and marks the editing
 * agent for `stop-gates.ts`. Never blocks: a finding without a fixer, types
 * and the other gates wait for the end of the turn.
 *
 * A rewrite reaches the agent as its diff in `additionalContext`. Claude Code
 * renders a Write or Edit result from the file path alone, so this is the one
 * channel that puts the rewritten code in front of the next edit. A tool
 * failure, a syntax error nearly every time, rides the same channel, ahead
 * of the diff of the passes before it.
 */

import { realpath } from "node:fs/promises";
import { basename, dirname, join, relative as relativeTo } from "node:path";

import { $ } from "bun";

import { HOOK_EXIT } from "./guard-destructive.ts";
import { checkoutRoot, markerFor } from "./stop-gates.ts";

export interface HookInput {
  session_id?: string;
  agent_id?: string;
  tool_input?: {
    file_path?: string;
  };
}

export interface Rewriter {
  tool: "oxlint --fix" | "oxfmt" | "shfmt";
  argv: string[];
}

const OXFMT_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs"] as const;

// Mirrors SHFMT_FLAGS in scripts/lint-shell.ts.
const SHFMT_FLAGS = ["-i", "2", "-ci"] as const;

const GIT_DIFF_FILES_DIFFER = 1;

export function parseHookInput(raw: string): HookInput | null {
  try {
    // SAFETY: every field of HookInput is optional, so a payload of another
    // shape reads back as absent fields and the hook does nothing.
    return JSON.parse(raw) as HookInput;
  } catch {
    return null;
  }
}

/** Repo-relative path, or null when the file sits outside the repo. */
export function toRepoRelative(filePath: string, repoRoot: string): string | null {
  const relative = relativeTo(repoRoot, filePath);

  return relative.startsWith("..") ? null : relative;
}

/** The tools that rewrite the file, in the order they run. */
export function rewritersFor(relativePath: string): Rewriter[] {
  // Bun installs node_modules as hard links into its global cache, and oxfmt
  // formats a file named there: the rewrite would reach every project's copy.
  if (relativePath.split("/").includes("node_modules")) return [];

  if (OXFMT_EXTENSIONS.some((ext) => relativePath.endsWith(ext))) {
    // Both tools read a path their config ignores as an unmatched pattern;
    // without the flag they exit non-zero there.
    const oxfmt: Rewriter = {
      tool: "oxfmt",
      argv: ["bun", "x", "oxfmt", "--no-error-on-unmatched-pattern", relativePath],
    };

    // `--fix` applies safe fixes only; `--silent` leaves the other findings
    // to the Stop gates. The default format still prints a summary line under
    // `--silent`, and oxlint switches to `agent` only when an agent variable
    // such as CLAUDECODE is set: pinned, the output does not depend on it.
    const oxlintFix: Rewriter = {
      tool: "oxlint --fix",
      argv: [
        "bun",
        "x",
        "oxlint",
        "--fix",
        "--silent",
        "--format=agent",
        "--no-error-on-unmatched-pattern",
        relativePath,
      ],
    };

    // Each tool can leave work for the other: a line oxfmt wraps can need the
    // blank lines of anti-slop/require-readable-spacing, and a fix can leave
    // code oxfmt would change.
    return [oxfmt, oxlintFix, oxfmt];
  }

  // archive/ is excluded as in scripts/lint-shell.ts.
  if (relativePath.endsWith(".sh") && !relativePath.startsWith("archive/")) {
    return [{ tool: "shfmt", argv: ["shfmt", ...SHFMT_FLAGS, "-w", relativePath] }];
  }

  return [];
}

/** The hunks of a `git diff`, without the header lines that name the compared files. */
export function diffHunks(diff: string): string {
  const lines = diff.trimEnd().split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@"));

  return firstHunk === -1 ? "" : lines.slice(firstHunk).join("\n");
}

export function hookOutput(additionalContext: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext },
  });
}

if (import.meta.main) {
  const projectDir = process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd();
  const input = parseHookInput(await Bun.stdin.text());
  const filePath = input?.tool_input?.file_path;
  const inProject = filePath === undefined ? null : toRepoRelative(filePath, projectDir);

  if (inProject === null) process.exit(HOOK_EXIT.ALLOW);

  const marker = input === null ? null : markerFor(input);

  if (marker !== null) await Bun.write(marker, "");

  const projectPath = join(projectDir, inProject);

  if (!(await Bun.file(projectPath).exists())) process.exit(HOOK_EXIT.ALLOW);

  // A worktree under the project carries its own oxlint config. Run from the
  // project, oxlint would load it as a nested config and fail on the
  // anti-slop plugin registered twice. git reports the root with symlinks
  // resolved; a file a symlink takes outside that root stays with the project.
  const directory = await realpath(dirname(projectPath));
  const checkout = await checkoutRoot(directory, projectDir);
  const inCheckout = toRepoRelative(join(directory, basename(projectPath)), checkout);
  const root = inCheckout === null ? projectDir : checkout;
  const relative = inCheckout ?? inProject;
  const file = join(root, relative);
  const before = await Bun.file(file).text();
  const rewrote = new Set<string>();
  const context: string[] = [];
  let current = before;

  for (const rewriter of rewritersFor(relative)) {
    const run = await $`${rewriter.argv}`.cwd(root).nothrow().quiet();
    const output = `${run.stdout.toString()}${run.stderr.toString()}`.trim();

    // oxlint exits 1 on a finding left without a fixer and on a failure;
    // with `--silent --format=agent` only a failure prints.
    const leftFindings = rewriter.tool === "oxlint --fix" && run.exitCode === 1 && output === "";

    if (run.exitCode !== 0 && !leftFindings) {
      context.push(`\`${rewriter.tool}\` failed on \`${inProject}\`:\n${output}`);
      break;
    }

    const after = await Bun.file(file).text();

    if (after !== current) rewrote.add(`\`${rewriter.tool}\``);

    current = after;
  }

  if (current !== before) {
    // stdin carries mode 100644, so an executable file differs by mode alone:
    // the exit code cannot stand in for the content comparison above.
    const diff =
      await $`git diff --no-index --no-color --no-ext-diff - ${relative} < ${new Blob([before])}`
        .cwd(root)
        .nothrow()
        .quiet();

    if (diff.exitCode !== GIT_DIFF_FILES_DIFFER) {
      throw new Error(`git diff --no-index exited ${diff.exitCode}: ${diff.stderr.toString()}`);
    }

    const hunks = diffHunks(diff.stdout.toString());
    const tools = [...rewrote].join(" and ");
    context.push(`${tools} rewrote \`${inProject}\`; it now reads as this diff:\n${hunks}`);
  }

  if (context.length > 0) console.log(hookOutput(context.join("\n\n")));
}
