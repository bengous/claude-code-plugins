#!/usr/bin/env bun

/**
 * Lefthook pre-commit hook — blocks direct commits to protected branches.
 */

const PROTECTED_BRANCHES: ReadonlySet<string> = new Set(["main", "master"]);

if (process.env["MAIN_BYPASS"] === "1") process.exit(0);

const head = Bun.spawnSync(["git", "symbolic-ref", "--short", "HEAD"], {
  stdout: "pipe",
  stderr: "pipe",
});

const branch = head.exitCode === 0 ? head.stdout.toString().trim() : null;

if (branch !== null && PROTECTED_BRANCHES.has(branch)) {
  console.error(`\nERROR: Direct commits to '${branch}' are blocked.`);
  console.error("Work on 'dev'; only the human fast-forwards 'main': docs/repo-ops.md.\n");
  process.exit(1);
}
