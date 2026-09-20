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
 *         "command": "bun .claude/hooks/guard-main-branch.ts",
 *         "timeout": 5
 *       }]
 *     }]
 *   }
 * }
 * ```
 */

import { HOOK_EXIT, parseHookInput, stripStringLiterals } from "./guard-destructive.ts";

const PROTECTED_BRANCHES = ["main", "master"] as const;

const BRANCH_MUTATION_PATTERNS: ReadonlyArray<RegExp> = [
  /git\s+commit\b/u,
  /git\s+push\b/u,
  /git\s+merge\b/u,
  /git\s+rebase\b/u,
];

export function getCurrentBranch(cwd: string = process.cwd()): string | null {
  const result = Bun.spawnSync(["git", "symbolic-ref", "--short", "HEAD"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) return null;

  return result.stdout.toString().trim();
}

// The common git dir, not the toplevel: every linked worktree of a repo shares
// it, so a worktree on a protected branch stays guarded.
export function getRepoIdentity(cwd: string): string | null {
  const result = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) return null;

  return result.stdout.toString().trim();
}

// The guarded repo is the one this file lives in: the file does not move,
// while CLAUDE_PROJECT_DIR and the shell cwd both drift. Other repos have
// their own conventions and aren't ours to police.
export function isForeignRepo(cwd: string): boolean {
  const ownIdentity = getRepoIdentity(import.meta.dir);
  const targetIdentity = getRepoIdentity(cwd);

  return ownIdentity !== null && targetIdentity !== null && ownIdentity !== targetIdentity;
}

// TODO: `git -C <path> commit` is not read; the hook's cwd decides for it.
// Extract the target directory of a leading `cd <path> &&` (or `;`) clause.
// Returns null if no leading cd is present. Quoted paths are unquoted.
export function extractCdTarget(cmd: string): string | null {
  const m = cmd.match(/^\s*cd\s+("(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&]+)\s*(?:&&|;)/u);
  const raw = m?.[1];

  if (raw === undefined) return null;

  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }

  return raw;
}

export function isProtectedBranch(branch: string): boolean {
  return PROTECTED_BRANCHES.some((protectedBranch) => protectedBranch === branch);
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

  const effectiveCwd = extractCdTarget(cmd) ?? process.cwd();

  if (isForeignRepo(effectiveCwd)) process.exit(HOOK_EXIT.ALLOW);

  const branch = getCurrentBranch(effectiveCwd);

  if (!branch || !isProtectedBranch(branch)) process.exit(HOOK_EXIT.ALLOW);

  console.error(`BLOCKED: '${branch}' is a protected branch.`);
  console.error("Work on 'dev' and merge via PR.");
  process.exit(HOOK_EXIT.BLOCK);
}
