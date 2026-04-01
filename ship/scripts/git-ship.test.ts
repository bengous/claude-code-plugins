import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

// Support both deployed (git-ship) and chezmoi source (executable_git-ship) names
const SCRIPT = existsSync(join(import.meta.dir, "git-ship"))
  ? join(import.meta.dir, "git-ship")
  : join(import.meta.dir, "executable_git-ship");

let tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const safe = prefix.replace(/[^a-zA-Z0-9-]/g, "-");
  const dir = mkdtempSync(join(tmpdir(), `git-ship-test-${safe}-`));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  tmpDirs = [];
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout, stderr, exitCode } = await $`git ${args}`.cwd(cwd).quiet().nothrow();
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr.toString().trim()}`);
  }
  return stdout.toString().trim();
}

async function runShip(cwd: string, ...args: string[]): Promise<{ exitCode: number; result: Record<string, unknown> }> {
  const { stdout, exitCode } = await $`bun run ${SCRIPT} ${args}`.cwd(cwd).quiet().nothrow();
  const out = stdout.toString().trim();
  try {
    return { exitCode, result: JSON.parse(out) };
  } catch {
    return { exitCode, result: { ok: false, error: `parse-error: ${out}`, step: "unknown" } };
  }
}

/** Create a bare "origin" repo and a cloned working repo with an initial commit on main. */
async function makeRepoWithOrigin(prefix: string): Promise<{ origin: string; repo: string }> {
  const origin = makeTmpDir(`${prefix}-origin`);
  const repo = makeTmpDir(prefix);

  // Init bare origin with main as default branch
  await git(origin, "init", "--bare", "--initial-branch=main");

  // Init working repo (not clone — clone of empty bare fails on some git versions)
  await git(repo, "init", "--initial-branch=main");
  await git(repo, "remote", "add", "origin", origin);

  // Configure
  await git(repo, "config", "user.email", "test@test.com");
  await git(repo, "config", "user.name", "Test");

  // Initial commit on main
  await Bun.write(join(repo, "init.txt"), "init");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial commit");
  await git(repo, "push", "-u", "origin", "main");

  return { origin, repo };
}

/** Create a feature branch with N commits. */
async function makeFeatureBranch(repo: string, branch: string, commits: string[]): Promise<void> {
  await git(repo, "checkout", "-b", branch);
  for (const msg of commits) {
    const filename = `${msg.replace(/\s+/g, "-").toLowerCase()}.txt`;
    await Bun.write(join(repo, filename), msg);
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", msg);
  }
}

/** Add commits to main (both local and origin) to simulate divergence. */
async function advanceMain(repo: string, commits: string[]): Promise<void> {
  const currentBranch = await git(repo, "branch", "--show-current");
  await git(repo, "checkout", "main");
  for (const msg of commits) {
    const filename = `main-${msg.replace(/\s+/g, "-").toLowerCase()}.txt`;
    await Bun.write(join(repo, filename), msg);
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", msg);
  }
  await git(repo, "push", "origin", "main");
  await git(repo, "checkout", currentBranch);
}

/** Create a worktree from a repo. Returns the worktree path. */
async function makeWorktree(repo: string, branch: string): Promise<string> {
  const wtDir = makeTmpDir(`wt-${branch}`);
  // Remove the dir first — git worktree add wants to create it
  rmSync(wtDir, { recursive: true });
  await git(repo, "worktree", "add", wtDir, branch);
  // Configure the worktree (git config is shared, but just in case)
  await git(wtDir, "config", "user.email", "test@test.com");
  await git(wtDir, "config", "user.name", "Test");
  return wtDir;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validate", () => {
  test("rejects dirty working directory", async () => {
    const { repo } = await makeRepoWithOrigin("dirty");
    await makeFeatureBranch(repo, "feature/dirty", ["commit 1"]);
    await Bun.write(join(repo, "untracked.txt"), "dirty");
    await git(repo, "add", "untracked.txt");

    const { exitCode, result } = await runShip(repo, "--no-squash");
    expect(exitCode).not.toBe(0);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("dirty-worktree");
    expect(result.step).toBe("validate");
  });

  test("rejects when on base branch", async () => {
    const { repo } = await makeRepoWithOrigin("onbase");

    const { exitCode, result } = await runShip(repo, "--no-squash");
    expect(exitCode).not.toBe(0);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("already-on-base");
  });

  test("rejects when base branch does not exist", async () => {
    const { repo } = await makeRepoWithOrigin("nobase");
    await makeFeatureBranch(repo, "feature/nobase", ["commit 1"]);

    const { exitCode, result } = await runShip(repo, "--no-squash", "--base", "nonexistent");
    expect(exitCode).not.toBe(0);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("base-not-found");
  });
});

// ---------------------------------------------------------------------------
// Rebase
// ---------------------------------------------------------------------------

describe("rebase", () => {
  test("rebases onto updated main", async () => {
    const { repo } = await makeRepoWithOrigin("rebase-clean");
    await makeFeatureBranch(repo, "feature/rebase", ["feature work"]);
    await advanceMain(repo, ["main advance"]);

    const { exitCode, result } = await runShip(repo, "--no-squash");
    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.step).toBe("merged");
  });

  test("reports rebase conflict and aborts cleanly", async () => {
    const { repo } = await makeRepoWithOrigin("rebase-conflict");
    // Create conflicting changes on same file
    await Bun.write(join(repo, "conflict.txt"), "base content");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "add conflict file");
    await git(repo, "push", "origin", "main");

    await git(repo, "checkout", "-b", "feature/conflict");
    await Bun.write(join(repo, "conflict.txt"), "feature content");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "feature change");

    await git(repo, "checkout", "main");
    await Bun.write(join(repo, "conflict.txt"), "main content");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "main change");
    await git(repo, "push", "origin", "main");
    await git(repo, "checkout", "feature/conflict");

    const { exitCode, result } = await runShip(repo, "--no-squash");
    expect(exitCode).not.toBe(0);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("rebase-conflict");
    expect(result.step).toBe("rebase");

    // Verify clean state after abort
    const status = await git(repo, "status", "--porcelain");
    expect(status).toBe("");
  });

  test("handles already up-to-date branch", async () => {
    const { repo } = await makeRepoWithOrigin("uptodate");
    await makeFeatureBranch(repo, "feature/uptodate", ["feature work"]);

    const { exitCode, result } = await runShip(repo, "--no-squash");
    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.step).toBe("merged");
  });
});

// ---------------------------------------------------------------------------
// Squash
// ---------------------------------------------------------------------------

describe("squash", () => {
  test("stages all changes and returns original subjects for 3 commits", async () => {
    const { repo } = await makeRepoWithOrigin("squash-3");
    await makeFeatureBranch(repo, "feature/squash3", ["Add login", "Fix typo", "Address review"]);

    const { exitCode, result } = await runShip(repo, "--squash");
    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.step).toBe("squash-staged");
    expect(result.original_subjects).toEqual(["Address review", "Fix typo", "Add login"]);

    // Verify changes are staged
    const status = await git(repo, "status", "--porcelain");
    expect(status).not.toBe("");
    // All should be staged (A = added)
    for (const line of status.split("\n").filter(Boolean)) {
      expect(line[0]).toBe("A");
    }
  });

  test("works with single commit", async () => {
    const { repo } = await makeRepoWithOrigin("squash-1");
    await makeFeatureBranch(repo, "feature/squash1", ["Single change"]);

    const { exitCode, result } = await runShip(repo, "--squash");
    expect(exitCode).toBe(0);
    expect(result.step).toBe("squash-staged");
    expect(result.original_subjects).toEqual(["Single change"]);
  });

  test("--continue succeeds after manual commit", async () => {
    const { repo } = await makeRepoWithOrigin("continue-ok");
    await makeFeatureBranch(repo, "feature/continue", ["Work 1", "Work 2"]);

    // First: squash
    const squashResult = await runShip(repo, "--squash");
    expect(squashResult.result.step).toBe("squash-staged");

    // Simulate skill committing
    await git(repo, "commit", "-m", "Semantic commit message");

    // Continue
    const { exitCode, result } = await runShip(repo, "--continue");
    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.step).toBe("merged");
    expect(result.squashed).toBe(true);
  });

  test("--continue fails if no commit was made", async () => {
    const { repo } = await makeRepoWithOrigin("continue-fail");
    await makeFeatureBranch(repo, "feature/noco", ["Work 1"]);

    // Squash
    await runShip(repo, "--squash");

    // Try continue without committing — but we need to re-commit the staged changes
    // to have a clean worktree for validation. Actually the worktree IS dirty (staged).
    // The validate step checks for dirty worktree... let's see what happens.
    // After squash, working dir has staged changes = dirty → validate rejects.
    // So --continue after squash without commit will fail at validate with dirty-worktree.
    const { exitCode, result } = await runShip(repo, "--continue");
    expect(exitCode).not.toBe(0);
    expect(result.ok).toBe(false);
    // Will fail with dirty-worktree since staged changes still present
    expect(result.error).toBe("dirty-worktree");
  });
});

// ---------------------------------------------------------------------------
// Merge — in-repo mode
// ---------------------------------------------------------------------------

describe("merge (in-repo)", () => {
  test("fast-forward merge without squash", async () => {
    const { repo } = await makeRepoWithOrigin("ff-nosquash");
    await makeFeatureBranch(repo, "feature/ff", ["Feature commit"]);

    const { exitCode, result } = await runShip(repo, "--no-squash");
    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.step).toBe("merged");
    expect(result.mode).toBe("repo");
    expect(result.squashed).toBe(false);

    // Verify main points to feature head
    const featureHead = await git(repo, "rev-parse", "feature/ff");
    const mainHead = await git(repo, "rev-parse", "main");
    expect(mainHead).toBe(featureHead);
  });

  test("returns to feature branch after merge", async () => {
    const { repo } = await makeRepoWithOrigin("return-branch");
    await makeFeatureBranch(repo, "feature/return", ["Work"]);

    await runShip(repo, "--no-squash");

    const branch = await git(repo, "branch", "--show-current");
    expect(branch).toBe("feature/return");
  });

  test("squash + continue merge in-repo", async () => {
    const { repo } = await makeRepoWithOrigin("squash-merge");
    await makeFeatureBranch(repo, "feature/sm", ["Commit A", "Commit B"]);

    // Squash
    await runShip(repo, "--squash");
    await git(repo, "commit", "-m", "Squashed feature");

    // Continue
    const { exitCode, result } = await runShip(repo, "--continue");
    expect(exitCode).toBe(0);
    expect(result.step).toBe("merged");
    expect(result.squashed).toBe(true);
    expect(result.mode).toBe("repo");

    // Verify main has exactly 2 commits (initial + squashed)
    const log = await git(repo, "log", "--oneline", "main");
    expect(log.split("\n")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Merge — worktree mode
// ---------------------------------------------------------------------------

describe("merge (worktree)", () => {
  test("merges via fetch from worktree to main repo", async () => {
    const { repo } = await makeRepoWithOrigin("wt-merge");
    await git(repo, "checkout", "-b", "feature/wt");
    await Bun.write(join(repo, "wt-file.txt"), "worktree content");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "Worktree commit");
    await git(repo, "checkout", "main");

    // Create worktree
    const wt = await makeWorktree(repo, "feature/wt");

    const { exitCode, result } = await runShip(wt, "--no-squash");
    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.step).toBe("merged");
    expect(result.mode).toBe("worktree");

    // Verify main in the main repo is updated
    const mainHead = await git(repo, "rev-parse", "main");
    const featureHead = await git(wt, "rev-parse", "HEAD");
    expect(mainHead).toBe(featureHead);
  });

  test("rejects merge when main worktree has untracked files", async () => {
    const { repo } = await makeRepoWithOrigin("wt-dirty-main");
    await git(repo, "checkout", "-b", "feature/wtdirty");
    await Bun.write(join(repo, "feature-file.txt"), "feature");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "Feature commit");
    await git(repo, "checkout", "main");

    const wt = await makeWorktree(repo, "feature/wtdirty");

    // Dirty the main worktree
    await Bun.write(join(repo, "dirty-main.txt"), "uncommitted");

    const { exitCode, result } = await runShip(wt, "--no-squash");
    expect(exitCode).not.toBe(0);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("dirty-main-worktree");
    expect(result.main_path).toBe(repo);
    expect(result.dirty_files).toContain("dirty-main.txt");
    expect(result.message).toContain("uncommitted changes");
  });

  test("rejects merge when main worktree has staged changes", async () => {
    const { repo } = await makeRepoWithOrigin("wt-staged-main");
    await git(repo, "checkout", "-b", "feature/wtstaged");
    await Bun.write(join(repo, "feature-file.txt"), "feature");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "Feature commit");
    await git(repo, "checkout", "main");

    const wt = await makeWorktree(repo, "feature/wtstaged");

    // Stage a change in main worktree
    await Bun.write(join(repo, "staged-main.txt"), "staged");
    await git(repo, "add", "staged-main.txt");

    const { exitCode, result } = await runShip(wt, "--no-squash");
    expect(exitCode).not.toBe(0);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("dirty-main-worktree");
  });

  test("syncs main worktree index after merge", async () => {
    const { repo } = await makeRepoWithOrigin("wt-index-sync");
    await git(repo, "checkout", "-b", "feature/wtindex");
    await Bun.write(join(repo, "index-file.txt"), "content");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "Index test commit");
    await git(repo, "checkout", "main");

    const wt = await makeWorktree(repo, "feature/wtindex");

    const { exitCode, result } = await runShip(wt, "--no-squash");
    expect(exitCode).toBe(0);
    expect(result.step).toBe("merged");

    // Main worktree index should be clean (no stale inverse diff)
    const status = await git(repo, "status", "--porcelain");
    expect(status).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

describe("dry run", () => {
  test("reports without making changes (squash)", async () => {
    const { repo } = await makeRepoWithOrigin("dry-squash");
    await makeFeatureBranch(repo, "feature/dry", ["A", "B", "C"]);
    const headBefore = await git(repo, "rev-parse", "HEAD");

    const { exitCode, result } = await runShip(repo, "--dry-run", "--squash");
    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.step).toBe("dry-run");
    expect(result.commits).toBe(3);
    expect(result.squash).toBe(true);

    // No state change
    const headAfter = await git(repo, "rev-parse", "HEAD");
    expect(headAfter).toBe(headBefore);
  });

  test("reports without making changes (no-squash)", async () => {
    const { repo } = await makeRepoWithOrigin("dry-nosquash");
    await makeFeatureBranch(repo, "feature/dryns", ["Work"]);

    const { exitCode, result } = await runShip(repo, "--dry-run", "--no-squash");
    expect(exitCode).toBe(0);
    expect(result.step).toBe("dry-run");
    expect(result.squash).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

describe("environment detection", () => {
  test("detects in-repo mode", async () => {
    const { repo } = await makeRepoWithOrigin("detect-repo");
    await makeFeatureBranch(repo, "feature/detect", ["Work"]);

    const { result } = await runShip(repo, "--dry-run", "--no-squash");
    expect(result.mode).toBe("repo");
  });

  test("detects worktree mode", async () => {
    const { repo } = await makeRepoWithOrigin("detect-wt");
    await git(repo, "checkout", "-b", "feature/detectwt");
    await Bun.write(join(repo, "f.txt"), "f");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "WF");
    await git(repo, "checkout", "main");

    const wt = await makeWorktree(repo, "feature/detectwt");

    const { result } = await runShip(wt, "--dry-run", "--no-squash");
    expect(result.mode).toBe("worktree");
  });
});

// ---------------------------------------------------------------------------
// Backup & restore (P2)
// ---------------------------------------------------------------------------

describe("backup & restore", () => {
  test("squash creates backup ref and includes it in output", async () => {
    const { repo } = await makeRepoWithOrigin("backup-create");
    await makeFeatureBranch(repo, "feature/backup", ["Work 1", "Work 2"]);
    const headBefore = await git(repo, "rev-parse", "HEAD");

    const { exitCode, result } = await runShip(repo, "--squash");
    expect(exitCode).toBe(0);
    expect(result.step).toBe("squash-staged");
    expect(result.backup_ref).toBe("refs/ship-backup/feature/backup");

    // Verify the ref actually exists and points to original HEAD
    const refSha = await git(repo, "rev-parse", "refs/ship-backup/feature/backup");
    expect(refSha).toBe(headBefore);
  });

  test("--restore recovers from squash", async () => {
    const { repo } = await makeRepoWithOrigin("restore-ok");
    await makeFeatureBranch(repo, "feature/restore", ["Work 1", "Work 2"]);
    const headBefore = await git(repo, "rev-parse", "HEAD");

    // Squash (creates backup)
    await runShip(repo, "--squash");

    // Restore
    const { exitCode, result } = await runShip(repo, "--restore");
    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.step).toBe("restored");
    expect(result.backup_ref).toBe("refs/ship-backup/feature/restore");

    // HEAD should be back to original
    const headAfter = await git(repo, "rev-parse", "HEAD");
    expect(headAfter).toBe(headBefore);

    // Backup ref should be deleted
    const { exitCode: refCheck } = await $`git rev-parse --verify refs/ship-backup/feature/restore`
      .cwd(repo)
      .quiet()
      .nothrow();
    expect(refCheck).not.toBe(0);
  });

  test("--restore fails when no backup exists", async () => {
    const { repo } = await makeRepoWithOrigin("restore-nobackup");
    await makeFeatureBranch(repo, "feature/nobackup", ["Work"]);

    const { exitCode, result } = await runShip(repo, "--restore");
    expect(exitCode).not.toBe(0);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no-backup");
  });

  test("second squash overwrites previous backup ref", async () => {
    const { repo } = await makeRepoWithOrigin("backup-overwrite");
    await makeFeatureBranch(repo, "feature/overwrite", ["Work 1", "Work 2"]);
    const head1 = await git(repo, "rev-parse", "HEAD");

    // First squash
    await runShip(repo, "--squash");
    const ref1 = await git(repo, "rev-parse", "refs/ship-backup/feature/overwrite");
    expect(ref1).toBe(head1);

    // Restore, add another commit, squash again
    await runShip(repo, "--restore");
    await Bun.write(join(repo, "extra.txt"), "extra");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "Extra work");
    const head2 = await git(repo, "rev-parse", "HEAD");

    await runShip(repo, "--squash");
    const ref2 = await git(repo, "rev-parse", "refs/ship-backup/feature/overwrite");
    expect(ref2).toBe(head2);
    expect(ref2).not.toBe(ref1);
  });
});

// ---------------------------------------------------------------------------
// not-ff retry (P3)
// ---------------------------------------------------------------------------

describe("not-ff retry", () => {
  test("--continue retries when main advanced (in-repo)", async () => {
    const { repo } = await makeRepoWithOrigin("retry-repo");
    await makeFeatureBranch(repo, "feature/retry", ["Work 1", "Work 2"]);

    // Squash
    await runShip(repo, "--squash");
    await git(repo, "commit", "-m", "Squashed feature");

    // Simulate main advancing while squash was in progress
    // We need to push from main, so save current branch context
    await git(repo, "stash"); // nothing to stash but that's ok — just need clean state for checkout
    await git(repo, "checkout", "main");
    await Bun.write(join(repo, "main-advance.txt"), "advanced");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "Main advanced");
    await git(repo, "push", "origin", "main");
    await git(repo, "checkout", "feature/retry");

    // --continue should detect not-ff, re-fetch+rebase, and succeed
    const { exitCode, result } = await runShip(repo, "--continue");
    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.step).toBe("merged");
  });

  test("--continue retries when main advanced (worktree)", async () => {
    const { repo } = await makeRepoWithOrigin("retry-wt");
    await git(repo, "checkout", "-b", "feature/retrywt");
    await Bun.write(join(repo, "feature.txt"), "feature");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "Feature work 1");
    await Bun.write(join(repo, "feature2.txt"), "feature2");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "Feature work 2");
    await git(repo, "checkout", "main");

    const wt = await makeWorktree(repo, "feature/retrywt");

    // Squash in worktree
    await runShip(wt, "--squash");
    await git(wt, "commit", "-m", "Squashed feature");

    // Advance main in the main repo
    await Bun.write(join(repo, "main-advance.txt"), "advanced");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "Main advanced");
    await git(repo, "push", "origin", "main");

    // --continue should retry
    const { exitCode, result } = await runShip(wt, "--continue");
    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.step).toBe("merged");
  });
});
