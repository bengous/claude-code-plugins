#!/usr/bin/env bun

// git-ship — Local merge tool for GPG-signed workflows.
// Rebases a feature branch onto base, optionally squashes, and merges via ff-only.
// Outputs structured JSON for consumption by the /ship Claude skill.

import { $ } from "bun";

const SCRIPT = "git-ship";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Mode = "worktree" | "repo";

type SuccessResult =
  | { ok: true; step: "squash-staged"; branch: string; base: string; mode: Mode; original_subjects: string[]; backup_ref: string }
  | { ok: true; step: "merged"; sha: string; branch: string; base: string; squashed: boolean; mode: Mode }
  | { ok: true; step: "restored"; branch: string; backup_ref: string };

type ErrorResult = {
  ok: false;
  error: string;
  step: "validate" | "rebase" | "squash" | "merge" | "restore";
  message?: string;
  main_path?: string;
  dirty_files?: string;
};

type DryRunResult = {
  ok: true;
  step: "dry-run";
  branch: string;
  base: string;
  mode: Mode;
  commits: number;
  squash: boolean;
};

type Result = SuccessResult | ErrorResult | DryRunResult;

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function git(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { stdout, stderr, exitCode } = await $`git ${args}`.quiet().nothrow();
  return { stdout: stdout.toString().trim(), stderr: stderr.toString().trim(), exitCode };
}

async function gitOk(...args: string[]): Promise<string> {
  const result = await git(...args);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  }
  return result.stdout;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function detectEnvironment(): Promise<{ mode: Mode; mainPath: string }> {
  const worktreeList = await gitOk("worktree", "list", "--porcelain");
  const entries = worktreeList.split("\n\n").filter(Boolean);
  const mainWorktree = entries[0]!.split("\n")[0]!.replace("worktree ", "");
  const toplevel = await gitOk("rev-parse", "--show-toplevel");

  if (toplevel === mainWorktree) {
    return { mode: "repo", mainPath: mainWorktree };
  }
  return { mode: "worktree", mainPath: mainWorktree };
}

async function validate(base: string): Promise<{ branch: string; mode: Mode; mainPath: string } | ErrorResult> {
  // Clean working directory
  const status = await gitOk("status", "--porcelain");
  if (status !== "") {
    return { ok: false, error: "dirty-worktree", step: "validate" };
  }

  // Not on base branch
  const branch = await gitOk("branch", "--show-current");
  if (branch === base) {
    return { ok: false, error: "already-on-base", step: "validate" };
  }

  // Base branch exists
  const baseCheck = await git("rev-parse", "--verify", base);
  if (baseCheck.exitCode !== 0) {
    return { ok: false, error: "base-not-found", step: "validate" };
  }

  const env = await detectEnvironment();
  return { branch, ...env };
}

async function fetchAndRebase(base: string): Promise<ErrorResult | null> {
  // Fetch — best effort (may fail if no remote, that's ok)
  await git("fetch", "origin", base);

  // Rebase onto the latest base
  const target = (await git("rev-parse", "--verify", `origin/${base}`)).exitCode === 0
    ? `origin/${base}`
    : base;

  const rebase = await git("rebase", target);
  if (rebase.exitCode !== 0) {
    // Abort the failed rebase to restore clean state
    await git("rebase", "--abort");
    return { ok: false, error: "rebase-conflict", step: "rebase" };
  }
  return null;
}

async function squash(base: string, branch: string): Promise<{ original_subjects: string[]; backup_ref: string } | ErrorResult> {
  // Find merge base with the local base branch (not origin — we already rebased)
  const mergeBase = await gitOk("merge-base", "HEAD", base);

  // Collect original commit subjects
  const subjectsRaw = await gitOk("log", "--format=%s", `${mergeBase}..HEAD`);
  const original_subjects = subjectsRaw.split("\n").filter(Boolean);

  // Backup before destructive reset
  const backupRef = `refs/ship-backup/${branch}`;
  await gitOk("update-ref", backupRef, "HEAD");

  // Soft reset — leaves changes staged
  await gitOk("reset", "--soft", mergeBase);

  return { original_subjects, backup_ref: backupRef };
}

async function continueAfterSquash(base: string): Promise<ErrorResult | null> {
  const mergeBase = await gitOk("merge-base", "HEAD", base);
  const head = await gitOk("rev-parse", "HEAD");

  if (head === mergeBase) {
    return { ok: false, error: "no-commit-after-squash", step: "squash" };
  }
  return null;
}

async function mergeIntoBase(
  branch: string,
  base: string,
  mode: Mode,
  mainPath: string,
): Promise<{ sha: string } | ErrorResult> {
  if (mode === "worktree") {
    // Worktree and main repo share the same .git — update the ref directly.
    // Guard: main worktree must be clean — update-ref would orphan uncommitted changes.
    const mainStatus = await git("-C", mainPath, "status", "--porcelain");
    if (mainStatus.stdout !== "") {
      return {
        ok: false,
        error: "dirty-main-worktree",
        step: "merge",
        message: `The main worktree at ${mainPath} has uncommitted changes. Merging would overwrite them. Stash or commit changes on main before shipping.`,
        main_path: mainPath,
        dirty_files: mainStatus.stdout,
      };
    }

    // Verify ff: base must be an ancestor of HEAD.
    const isAncestor = await git("merge-base", "--is-ancestor", base, "HEAD");
    if (isAncestor.exitCode !== 0) {
      return { ok: false, error: "not-ff", step: "merge" };
    }
    const newSha = await gitOk("rev-parse", "HEAD");
    await gitOk("update-ref", `refs/heads/${base}`, newSha);
    // Sync main worktree with updated HEAD (P6 guard ensures it was clean)
    await git("-C", mainPath, "reset", "--hard");
  } else {
    // In-repo mode: checkout base, merge, checkout back
    await gitOk("checkout", base);
    const merge = await git("merge", "--ff-only", branch);
    if (merge.exitCode !== 0) {
      // Go back to feature branch
      await git("checkout", branch);
      return { ok: false, error: "not-ff", step: "merge" };
    }
    await gitOk("checkout", branch);
  }

  // Get the sha that base now points to
  const sha = mode === "worktree"
    ? await gitOk("-C", mainPath, "rev-parse", base)
    : await gitOk("rev-parse", base);

  return { sha };
}

async function mergeWithRetry(
  branch: string,
  base: string,
  mode: Mode,
  mainPath: string,
): Promise<{ sha: string } | ErrorResult> {
  const result = await mergeIntoBase(branch, base, mode, mainPath);
  if (!("ok" in result) || result.error !== "not-ff") return result;

  // main advanced — re-fetch, rebase, retry once
  const rebaseErr = await fetchAndRebase(base);
  if (rebaseErr !== null) return rebaseErr;
  return mergeIntoBase(branch, base, mode, mainPath);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<Result> {
  const args = Bun.argv.slice(2);

  // Parse args
  let base = "main";
  let doSquash: boolean | null = null;
  let dryRun = false;
  let continueMode = false;
  let restoreMode = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--base":
        base = args[++i]!;
        break;
      case "--squash":
        doSquash = true;
        break;
      case "--no-squash":
        doSquash = false;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--continue":
        continueMode = true;
        break;
      case "--restore":
        restoreMode = true;
        break;
      default:
        return { ok: false, error: `unknown argument: ${args[i]}`, step: "validate" };
    }
  }

  // Restore mode — recover from a failed squash
  if (restoreMode) {
    const branch = await gitOk("branch", "--show-current");
    const backupRef = `refs/ship-backup/${branch}`;
    const check = await git("rev-parse", "--verify", backupRef);
    if (check.exitCode !== 0) {
      return { ok: false, error: "no-backup", step: "restore" };
    }
    await gitOk("reset", "--hard", backupRef);
    await gitOk("update-ref", "-d", backupRef);
    return { ok: true, step: "restored", branch, backup_ref: backupRef };
  }

  // Continue mode — resume after squash commit
  if (continueMode) {
    const validation = await validate(base);
    if ("ok" in validation) return validation;

    const continueErr = await continueAfterSquash(base);
    if (continueErr !== null) return continueErr;

    const mergeResult = await mergeWithRetry(validation.branch, base, validation.mode, validation.mainPath);
    if ("ok" in mergeResult) return mergeResult;

    return {
      ok: true,
      step: "merged",
      sha: mergeResult.sha,
      branch: validation.branch,
      base,
      squashed: true,
      mode: validation.mode,
    };
  }

  // Normal mode
  const validation = await validate(base);
  if ("ok" in validation) return validation;
  const { branch, mode, mainPath } = validation;

  // Dry run
  if (dryRun) {
    const mergeBase = await gitOk("merge-base", "HEAD", base);
    const logRaw = await gitOk("log", "--oneline", `${mergeBase}..HEAD`);
    const commits = logRaw.split("\n").filter(Boolean).length;
    return { ok: true, step: "dry-run", branch, base, mode, commits, squash: doSquash ?? false };
  }

  // Rebase
  const rebaseErr = await fetchAndRebase(base);
  if (rebaseErr !== null) return rebaseErr;

  // Squash path
  if (doSquash) {
    const squashResult = await squash(base, branch);
    if ("ok" in squashResult) return squashResult;
    return {
      ok: true,
      step: "squash-staged",
      branch,
      base,
      mode,
      original_subjects: squashResult.original_subjects,
      backup_ref: squashResult.backup_ref,
    };
  }

  // No-squash: merge directly
  const mergeResult = await mergeWithRetry(branch, base, mode, mainPath);
  if ("ok" in mergeResult) return mergeResult;

  return {
    ok: true,
    step: "merged",
    sha: mergeResult.sha,
    branch,
    base,
    squashed: false,
    mode,
  };
}

if (import.meta.main) {
  const result = await main();
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
