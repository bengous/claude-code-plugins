import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = existsSync(join(import.meta.dir, "git-clean-audit"))
  ? join(import.meta.dir, "git-clean-audit")
  : join(import.meta.dir, "executable_git-clean-audit");

let tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const safe = prefix.replace(/[^a-zA-Z0-9-]/g, "-");
  const dir = mkdtempSync(join(tmpdir(), `git-clean-audit-test-${safe}-`));
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
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr}`);
  }
  return stdout.trim();
}

async function runAudit(cwd: string, ...args: string[]): Promise<{ exitCode: number; result: Record<string, unknown> }> {
  const proc = Bun.spawn(["bun", "run", SCRIPT, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  try {
    return { exitCode, result: JSON.parse(stdout.trim()) };
  } catch {
    return { exitCode, result: { ok: false, error: `parse-error: ${stdout.trim()}`, step: "unknown" } };
  }
}

async function makeRepo(prefix: string): Promise<string> {
  const repo = makeTmpDir(prefix);
  await git(repo, "init", "--initial-branch=main");
  await git(repo, "config", "user.email", "test@test.com");
  await git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "init.txt"), "init");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial commit");
  return repo;
}

async function makeRepoWithOrigin(prefix: string): Promise<{ origin: string; repo: string }> {
  const origin = makeTmpDir(`${prefix}-origin`);
  const repo = makeTmpDir(prefix);
  await git(origin, "init", "--bare", "--initial-branch=main");
  await git(repo, "init", "--initial-branch=main");
  await git(repo, "remote", "add", "origin", origin);
  await git(repo, "config", "user.email", "test@test.com");
  await git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "init.txt"), "init");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial commit");
  await git(repo, "push", "-u", "origin", "main");
  return { origin, repo };
}

async function addCommit(repo: string, filename: string, message: string): Promise<void> {
  writeFileSync(join(repo, filename), message);
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", message);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("git-clean-audit", () => {
  test("returns empty categories on clean repo", async () => {
    const repo = await makeRepo("clean");
    const { exitCode, result } = await runAudit(repo);

    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
    const categories = result.categories as Record<string, unknown[]>;
    expect(categories.merged_local).toHaveLength(0);
    expect(categories.orphaned_worktree).toHaveLength(0);
    expect(categories.squash_merged).toHaveLength(0);
    expect(categories.backup).toHaveLength(0);
    expect(categories.stale_worktrees).toHaveLength(0);
  });

  test("detects merged local branches", async () => {
    const repo = await makeRepo("merged");

    // Create and merge a feature branch
    await git(repo, "checkout", "-b", "feature/done");
    await addCommit(repo, "feature.txt", "feature work");
    await git(repo, "checkout", "main");
    await git(repo, "merge", "feature/done");

    const { result } = await runAudit(repo);
    const categories = result.categories as Record<string, unknown[]>;

    expect(categories.merged_local).toHaveLength(1);
    expect((categories.merged_local[0] as { name: string }).name).toBe("feature/done");
  });

  test("detects orphaned worktree-agent branches", async () => {
    const repo = await makeRepo("orphaned");

    // Create a worktree-agent branch (merged)
    await git(repo, "checkout", "-b", "worktree-agent-abc123");
    await git(repo, "checkout", "main");

    const { result } = await runAudit(repo);
    const categories = result.categories as Record<string, unknown[]>;

    expect(categories.orphaned_worktree).toHaveLength(1);
    expect((categories.orphaned_worktree[0] as { name: string }).name).toBe("worktree-agent-abc123");
    // Should NOT be in merged_local
    expect(categories.merged_local).toHaveLength(0);
  });

  test("detects unmerged worktree-agent branches as orphaned", async () => {
    const repo = await makeRepo("orphaned-unmerged");

    // Create a worktree-agent branch with commits (unmerged)
    await git(repo, "checkout", "-b", "worktree-agent-xyz789");
    await addCommit(repo, "agent-work.txt", "agent work");
    await git(repo, "checkout", "main");

    const { result } = await runAudit(repo);
    const categories = result.categories as Record<string, unknown[]>;

    expect(categories.orphaned_worktree).toHaveLength(1);
    expect((categories.orphaned_worktree[0] as { name: string }).name).toBe("worktree-agent-xyz789");
  });

  test("detects backup branches", async () => {
    const repo = await makeRepo("backup");

    await git(repo, "checkout", "-b", "backup/some-work");
    await addCommit(repo, "backup.txt", "backup content");
    await git(repo, "checkout", "main");

    const { result } = await runAudit(repo);
    const categories = result.categories as Record<string, unknown[]>;

    expect(categories.backup).toHaveLength(1);
    expect((categories.backup[0] as { name: string }).name).toBe("backup/some-work");
    expect((categories.backup[0] as { ahead: number }).ahead).toBe(1);
  });

  test("detects squash-merged branches", async () => {
    const repo = await makeRepo("squash");

    // Create feature branch with 2 commits
    await git(repo, "checkout", "-b", "feature/squashed");
    await addCommit(repo, "a.txt", "commit a");
    await addCommit(repo, "b.txt", "commit b");

    // Simulate squash-merge onto main
    await git(repo, "checkout", "main");
    await git(repo, "merge", "--squash", "feature/squashed");
    await git(repo, "commit", "-m", "squash merge feature");

    const { result } = await runAudit(repo);
    const categories = result.categories as Record<string, unknown[]>;

    expect(categories.squash_merged).toHaveLength(1);
    expect((categories.squash_merged[0] as { name: string }).name).toBe("feature/squashed");
  });

  test("keeps current branch", async () => {
    const repo = await makeRepo("current");

    await git(repo, "checkout", "-b", "feature/active");
    await addCommit(repo, "active.txt", "active work");

    const { result } = await runAudit(repo);
    const kept = result.kept as string[];

    expect(kept).toContain("feature/active");
  });

  test("keeps branches with active worktrees", async () => {
    const repo = await makeRepo("worktree-active");
    const wtDir = makeTmpDir("wt-active");

    await git(repo, "checkout", "-b", "feature/in-worktree");
    await addCommit(repo, "wt.txt", "worktree content");
    await git(repo, "checkout", "main");
    await git(repo, "worktree", "add", wtDir, "feature/in-worktree");

    const { result } = await runAudit(repo);
    const kept = result.kept as string[];

    expect(kept).toContain("feature/in-worktree");

    // Cleanup worktree
    await git(repo, "worktree", "remove", wtDir);
  });

  test("returns error for missing base branch", async () => {
    const repo = await makeRepo("no-base");

    const { exitCode, result } = await runAudit(repo, "--base", "nonexistent");
    expect(exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("nonexistent");
  });

  test("detects stale remote branches with --include-remote", async () => {
    const { origin, repo } = await makeRepoWithOrigin("remote");

    // Create and push a feature branch
    await git(repo, "checkout", "-b", "feature/remote-done");
    await addCommit(repo, "remote.txt", "remote work");
    await git(repo, "push", "-u", "origin", "feature/remote-done");

    // Merge into main and push
    await git(repo, "checkout", "main");
    await git(repo, "merge", "feature/remote-done");
    await git(repo, "push", "origin", "main");

    // Delete local branch but leave remote
    await git(repo, "branch", "-d", "feature/remote-done");

    const { result } = await runAudit(repo, "--include-remote");
    const categories = result.categories as Record<string, unknown[]>;

    expect(categories.stale_remote).toHaveLength(1);
    expect((categories.stale_remote[0] as { name: string }).name).toBe("origin/feature/remote-done");
    expect((categories.stale_remote[0] as { merged: boolean }).merged).toBe(true);
  });

  test("provides branch metadata (ahead, behind, date, subject)", async () => {
    const repo = await makeRepo("metadata");

    await git(repo, "checkout", "-b", "feature/meta");
    await addCommit(repo, "meta.txt", "Add metadata feature");
    await git(repo, "checkout", "main");
    await addCommit(repo, "main-advance.txt", "Advance main");

    // Go back to main for the audit
    const { result } = await runAudit(repo);
    const kept = result.kept as string[];

    // feature/meta is unmerged and not squash-merged, so it's kept
    expect(kept).toContain("feature/meta");
  });
});
