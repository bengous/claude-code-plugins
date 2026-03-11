#!/usr/bin/env bun

/**
 * Lefthook pre-commit hook — blocks direct commits to protected branches.
 * Delegates branch detection to the shared guard-main-branch module.
 */

import {
	getCurrentBranch,
	isProtectedBranch,
} from "../../_shared/claude-cli/hooks/guard-main-branch.ts";

if (process.env["MAIN_BYPASS"] === "1") process.exit(0);

const branch = getCurrentBranch();
if (branch && isProtectedBranch(branch)) {
	console.error(`\nERROR: Direct commits to '${branch}' are blocked.`);
	console.error("Work on 'dev' and merge via PR.\n");
	process.exit(1);
}
