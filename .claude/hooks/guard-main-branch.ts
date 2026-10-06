#!/usr/bin/env bun

/**
 * PreToolUse hook for Bash — blocks git commit/push on protected branches.
 * Receives Claude Code tool JSON on stdin.
 *
 * Reuses stripStringLiterals from hook-io so that commit messages
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
 *         "command": "bun .claude/hooks/guard-main-branch.ts",
 *         "timeout": 5
 *       }]
 *     }]
 *   }
 * }
 * ```
 */

import { HOOK_EXIT, parseHookInput, stripStringLiterals } from "./hook-io.ts";

const PROTECTED_BRANCHES = ["main", "master"] as const;

const WORD = String.raw`(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&"'])+`;

const OPTION_WITH_ARGUMENT = String.raw`(?:-[Cc]|--(?:git-dir|work-tree|namespace|config-env|attr-source))`;

const BRANCH_MUTATION = new RegExp(
  String.raw`git((?:\s+(?:${OPTION_WITH_ARGUMENT}\s+${WORD}|(?!${OPTION_WITH_ARGUMENT}\s)-${WORD}))*)\s+(?:commit|push|merge|rebase)(?=$|[\s;&|)])`,
  "gu",
);

const GLOBAL_OPTION = new RegExp(String.raw`(${OPTION_WITH_ARGUMENT})\s+(${WORD})|-${WORD}`, "gu");

export function getCurrentBranch(
  cwd: string = process.cwd(),
  gitOptions: ReadonlyArray<string> = [],
): string | null {
  const result = Bun.spawnSync(["git", ...gitOptions, "symbolic-ref", "--short", "HEAD"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) return null;

  return result.stdout.toString().trim();
}

// The common git dir, not the toplevel: every linked worktree of a repo shares
// it, so a worktree on a protected branch stays guarded.
export function getRepoIdentity(
  cwd: string,
  gitOptions: ReadonlyArray<string> = [],
): string | null {
  const result = Bun.spawnSync(
    ["git", ...gitOptions, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );

  if (result.exitCode !== 0) return null;

  return result.stdout.toString().trim();
}

// The guarded repo is the one this file lives in: the file does not move,
// while CLAUDE_PROJECT_DIR and the shell cwd both drift. Other repos have
// their own conventions and aren't ours to police.
export function isForeignRepo(cwd: string, gitOptions: ReadonlyArray<string> = []): boolean {
  const ownIdentity = getRepoIdentity(import.meta.dir);
  const targetIdentity = getRepoIdentity(cwd, gitOptions);

  return ownIdentity !== null && targetIdentity !== null && ownIdentity !== targetIdentity;
}

function unquote(word: string): string {
  return word.replaceAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/gu, "$1$2");
}

// Extract the target directory of a leading `cd <path> &&` (or `;`) clause.
// Returns null if no leading cd is present. Quoted paths are unquoted.
export function extractCdTarget(cmd: string): string | null {
  const m = cmd.match(/^\s*cd\s+("(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&]+)\s*(?:&&|;)/u);
  const raw = m?.[1];

  if (raw === undefined) return null;

  return unquote(raw);
}

// Per branch-mutating git invocation, the `-C` and `--git-dir` options that
// locate its repository, unquoted and in order: replayed to git, they resolve
// as the invocation will, relative paths and chained `-C` included.
export function branchMutations(cmd: string): ReadonlyArray<ReadonlyArray<string>> {
  return [...cmd.matchAll(BRANCH_MUTATION)].map(([, globalOptions = ""]) =>
    [...globalOptions.matchAll(GLOBAL_OPTION)].flatMap(([option, name, value = ""]) => {
      if (name === "-C" || name === "--git-dir") return [name, unquote(value)];

      if (option.startsWith("--git-dir=")) {
        return ["--git-dir", unquote(option.slice("--git-dir=".length))];
      }

      return [];
    }),
  );
}

export function isProtectedBranch(branch: string): boolean {
  return PROTECTED_BRANCHES.some((protectedBranch) => protectedBranch === branch);
}

export function isBranchMutatingCommand(cmd: string): boolean {
  return branchMutations(stripStringLiterals(cmd)).length > 0;
}

export { parseHookInput };

// FIXME: two regex readings of the command, stripped for detection and raw for
// targets, disagree, and neither expands `~`, `$VAR` or `$(…)`: a target or a
// `cd` the hook cannot resolve passes. One shell parse (shfmt --to-json, as
// scripts/check-frozen-facts.ts reads shell) that fails closed on what it
// cannot resolve, shared with guard-git-push.ts, would close them together.
if (import.meta.main) {
  if (process.env["MAIN_BYPASS"] === "1") process.exit(HOOK_EXIT.ALLOW);

  const input = await Bun.stdin.text();
  const cmd = parseHookInput(input);

  if (!cmd) process.exit(HOOK_EXIT.ALLOW);

  if (!isBranchMutatingCommand(cmd)) process.exit(HOOK_EXIT.ALLOW);

  const cwd = extractCdTarget(cmd) ?? process.cwd();

  for (const gitOptions of branchMutations(cmd)) {
    const branch = isForeignRepo(cwd, gitOptions) ? null : getCurrentBranch(cwd, gitOptions);

    if (branch && isProtectedBranch(branch)) {
      console.error(`BLOCKED: '${branch}' is a protected branch.`);
      console.error("Work on 'dev'; only the human fast-forwards 'main': docs/repo-ops.md.");
      process.exit(HOOK_EXIT.BLOCK);
    }
  }
}
