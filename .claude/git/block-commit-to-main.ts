#!/usr/bin/env bun

/**
 * Lefthook pre-commit hook — blocks direct commits to protected branches.
 */

import { gitSync } from "../../tools/platform/git.ts";

const PROTECTED_BRANCHES: ReadonlySet<string> = new Set(["main", "master"]);

if (process.env["MAIN_BYPASS"] === "1") process.exit(0);

const head = gitSync(["symbolic-ref", "--short", "HEAD"]);

const branch = head.kind === "exited" && head.code === 0 ? head.stdout.trim() : null;

if (branch !== null && PROTECTED_BRANCHES.has(branch)) {
  console.error(`\nERROR: Direct commits to '${branch}' are blocked.`);
  console.error("Work on 'dev'; only the human fast-forwards 'main': docs/repo-ops.md.\n");
  process.exit(1);
}
