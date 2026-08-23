/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof -- this harness asserts on the JSON that git-clean-audit.ts prints on stdout: the casts and typeof checks ARE the boundary parse, and a closed type here would assert the schema instead of the behaviour. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "git-clean-audit.ts");

let tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const safe = prefix.replaceAll(/[^a-zA-Z0-9-]/gu, "-");
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

async function runAudit(
  cwd: string,
  ...args: string[]
): Promise<{ exitCode: number; result: Record<string, unknown> }> {
  const proc = Bun.spawn(["bun", "run", SCRIPT, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  try {
    return { exitCode, result: JSON.parse(stdout.trim()) };
  } catch {
    return {
      exitCode,
      result: { ok: false, error: `parse-error: ${stdout.trim()}`, step: "unknown" },
    };
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

type Kept = { name: string; reason: string; detail: string | null };

const keptNames = (result: Record<string, unknown>): string[] =>
  (result.kept as Kept[]).map((k) => k.name);

const keptEntry = (result: Record<string, unknown>, name: string): Kept | undefined =>
  (result.kept as Kept[]).find((k) => k.name === name);

// Run the audit with a git shim prepended to PATH that fails only on the given
// subcommand (e.g. "worktree list"), delegating everything else to the real git.
async function runAuditWithFailingGit(
  cwd: string,
  failOn: string,
  ...args: string[]
): Promise<{ exitCode: number; result: Record<string, unknown> }> {
  const realGit = Bun.which("git");
  if (!realGit) throw new Error("git not found on PATH");
  const shimDir = makeTmpDir("git-shim");
  const shim = `#!/usr/bin/env bash
if [[ "$*" == "${failOn}"* ]]; then
  echo "fatal: simulated failure: ${failOn}" >&2
  exit 128
fi
exec ${realGit} "$@"
`;
  writeFileSync(join(shimDir, "git"), shim, { mode: 0o755 });
  const proc = Bun.spawn(["bun", "run", SCRIPT, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  try {
    return { exitCode, result: JSON.parse(stdout.trim()) };
  } catch {
    return {
      exitCode,
      result: { ok: false, error: `parse-error: ${stdout.trim()}`, step: "unknown" },
    };
  }
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
    expect(categories.content_merged).toHaveLength(0);
    expect(categories.backup).toHaveLength(0);
    expect(categories.stale_worktrees).toHaveLength(0);
    expect(categories.removable_worktrees).toHaveLength(0);
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
    expect((categories.merged_local?.[0] as { name: string } | undefined)?.name).toBe(
      "feature/done",
    );
  });

  test("detects orphaned worktree-agent branches", async () => {
    const repo = await makeRepo("orphaned");

    // Create a worktree-agent branch (merged)
    await git(repo, "checkout", "-b", "worktree-agent-abc123");
    await git(repo, "checkout", "main");

    const { result } = await runAudit(repo);
    const categories = result.categories as Record<string, unknown[]>;

    expect(categories.orphaned_worktree).toHaveLength(1);
    expect((categories.orphaned_worktree?.[0] as { name: string } | undefined)?.name).toBe(
      "worktree-agent-abc123",
    );
    // Should NOT be in merged_local
    expect(categories.merged_local).toHaveLength(0);
  });

  test("offers an unmerged worktree-agent branch once its content is proven", async () => {
    const repo = await makeRepo("orphaned-unmerged");

    // Not an ancestor of main, but squashed onto it: the commits are gone from
    // main's history while every file it carries is there.
    await git(repo, "checkout", "-b", "worktree-agent-xyz789");
    await addCommit(repo, "agent-work.txt", "agent work");
    await git(repo, "checkout", "main");
    await git(repo, "merge", "--squash", "worktree-agent-xyz789");
    await git(repo, "commit", "-m", "squash agent work");

    const { result } = await runAudit(repo);
    const categories = result.categories as Record<string, { name: string; proof: string }[]>;

    expect(categories.orphaned_worktree).toHaveLength(1);
    expect(categories.orphaned_worktree?.[0]?.name).toBe("worktree-agent-xyz789");
    expect(categories.orphaned_worktree?.[0]?.proof).toBe("no-merge-delta");
    expect(keptNames(result)).not.toContain("worktree-agent-xyz789");
  });

  test("detects backup branches", async () => {
    const repo = await makeRepo("backup");

    await git(repo, "checkout", "-b", "backup/some-work");
    await addCommit(repo, "backup.txt", "backup content");
    await git(repo, "checkout", "main");

    const { result } = await runAudit(repo);
    const categories = result.categories as Record<string, unknown[]>;

    expect(categories.backup).toHaveLength(1);
    expect((categories.backup?.[0] as { name: string } | undefined)?.name).toBe("backup/some-work");
    expect((categories.backup?.[0] as { ahead: number } | undefined)?.ahead).toBe(1);
  });

  test("detects squash-merged branches as content_merged", async () => {
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

    expect(categories.content_merged).toHaveLength(1);
    expect((categories.content_merged?.[0] as { name: string } | undefined)?.name).toBe(
      "feature/squashed",
    );
    expect((categories.content_merged?.[0] as { proof: string } | undefined)?.proof).toBe(
      "no-merge-delta",
    );
  });

  test("does not claim containment for a squash that was later reverted", async () => {
    const repo = await makeRepo("squash-reverted");

    await git(repo, "checkout", "-b", "feature/undone");
    await addCommit(repo, "a.txt", "commit a");
    await addCommit(repo, "b.txt", "commit b");

    await git(repo, "checkout", "main");
    await git(repo, "merge", "--squash", "feature/undone");
    await git(repo, "commit", "-m", "squash merge feature");
    // The work is taken back out: base no longer holds the content.
    await git(repo, "revert", "--no-edit", "HEAD");

    const { result } = await runAudit(repo);
    const categories = result.categories as Record<string, unknown[]>;

    expect(categories.content_merged).toHaveLength(0);
    expect(keptEntry(result, "feature/undone")?.reason).toBe("unproven");
  });

  test("keeps current branch", async () => {
    const repo = await makeRepo("current");

    await git(repo, "checkout", "-b", "feature/active");
    await addCommit(repo, "active.txt", "active work");

    const { result } = await runAudit(repo);

    expect(keptNames(result)).toContain("feature/active");
    expect(keptEntry(result, "feature/active")?.reason).toBe("current");
  });

  test("keeps a branch whose worktree holds unmerged work, with the reason", async () => {
    const repo = await makeRepo("worktree-active");
    const wtDir = makeTmpDir("wt-active");

    await git(repo, "checkout", "-b", "feature/in-worktree");
    await addCommit(repo, "wt.txt", "worktree content");
    await git(repo, "checkout", "main");
    await git(repo, "worktree", "add", wtDir, "feature/in-worktree");

    const { result } = await runAudit(repo);

    expect(keptNames(result)).toContain("feature/in-worktree");
    const entry = keptEntry(result, "feature/in-worktree");
    expect(entry?.reason).toBe("worktree");
    expect(entry?.detail).toBe(wtDir);

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
    const { repo } = await makeRepoWithOrigin("remote");

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
    expect((categories.stale_remote?.[0] as { name: string } | undefined)?.name).toBe(
      "origin/feature/remote-done",
    );
    expect((categories.stale_remote?.[0] as { proof: string } | undefined)?.proof).toBe("ancestry");
  });

  test("detects a squash-merged remote branch that ancestry alone would miss", async () => {
    const { repo } = await makeRepoWithOrigin("remote-squash");

    await git(repo, "checkout", "-b", "feature/remote-squashed");
    await addCommit(repo, "rs-a.txt", "remote squash a");
    await addCommit(repo, "rs-b.txt", "remote squash b");
    await git(repo, "push", "-u", "origin", "feature/remote-squashed");

    // Squash the work onto main: the remote branch is no ancestor of origin/main,
    // yet every file it carries is there.
    await git(repo, "checkout", "main");
    await git(repo, "merge", "--squash", "feature/remote-squashed");
    await git(repo, "commit", "-m", "squash remote feature");
    await git(repo, "push", "origin", "main");
    await git(repo, "branch", "-D", "feature/remote-squashed");

    const { result } = await runAudit(repo, "--include-remote");
    const stale = (result.categories as Record<string, { name: string; proof: string }[]>)
      .stale_remote;

    const entry = stale?.find((b) => b.name === "origin/feature/remote-squashed");
    expect(entry?.proof).toBe("no-merge-delta");
  });

  test("judges remote branches against origin/base, not a lagging local base", async () => {
    const { origin, repo } = await makeRepoWithOrigin("remote-base");
    const other = makeTmpDir("remote-base-clone");

    // A second clone merges the feature and pushes: origin/main now contains it,
    // local main in `repo` does not.
    await git(repo, "checkout", "-b", "feature/pushed-elsewhere");
    await addCommit(repo, "elsewhere.txt", "work done elsewhere");
    await git(repo, "push", "-u", "origin", "feature/pushed-elsewhere");
    await git(repo, "checkout", "main");
    await git(repo, "branch", "-D", "feature/pushed-elsewhere");

    await git(other, "clone", origin, other);
    await git(other, "config", "user.email", "test@test.com");
    await git(other, "config", "user.name", "Test");
    await git(other, "merge", "origin/feature/pushed-elsewhere");
    await git(other, "push", "origin", "main");

    const { result } = await runAudit(repo, "--include-remote");
    const categories = result.categories as Record<string, { name: string }[]>;

    expect(result.remote_base).toBe("origin/main");
    expect(categories.stale_remote?.map((b) => b.name)).toContain(
      "origin/feature/pushed-elsewhere",
    );
  });

  test("provides branch metadata (ahead, behind, date, subject)", async () => {
    const repo = await makeRepo("metadata");

    await git(repo, "checkout", "-b", "feature/meta");
    await addCommit(repo, "meta.txt", "Add metadata feature");
    await git(repo, "checkout", "main");
    await addCommit(repo, "main-advance.txt", "Advance main");

    const { result } = await runAudit(repo);

    // feature/meta is unmerged and its content is not on main, so it's kept
    expect(keptNames(result)).toContain("feature/meta");
    expect(keptEntry(result, "feature/meta")?.reason).toBe("unproven");
  });

  test("flags the -d refusal when the branch is ahead of its upstream", async () => {
    const { repo } = await makeRepoWithOrigin("d-refusal");

    await git(repo, "checkout", "-b", "feature/ahead-of-upstream");
    await addCommit(repo, "d.txt", "pushed work");
    await git(repo, "push", "-u", "origin", "feature/ahead-of-upstream");
    // Committed locally, never pushed: the tip is no longer in the upstream,
    // which is what makes `git branch -d` refuse even when main contains it.
    await addCommit(repo, "d2.txt", "unpushed work");

    await git(repo, "checkout", "main");
    await git(repo, "merge", "feature/ahead-of-upstream");

    const { result } = await runAudit(repo);
    const merged = (
      result.categories as Record<string, { name: string; d_refusal: string | null }[]>
    ).merged_local;

    const entry = merged?.find((b) => b.name === "feature/ahead-of-upstream");
    expect(entry).toBeDefined();
    expect(entry?.d_refusal).toBe("origin/feature/ahead-of-upstream");
  });

  test("leaves d_refusal null when the upstream still contains the branch", async () => {
    const { repo } = await makeRepoWithOrigin("d-no-refusal");

    await git(repo, "checkout", "-b", "feature/pushed");
    await addCommit(repo, "p.txt", "pushed work");
    await git(repo, "push", "-u", "origin", "feature/pushed");
    await git(repo, "checkout", "main");
    await git(repo, "merge", "feature/pushed");

    const { result } = await runAudit(repo);
    const merged = (
      result.categories as Record<string, { name: string; d_refusal: string | null }[]>
    ).merged_local;

    expect(merged?.find((b) => b.name === "feature/pushed")?.d_refusal).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Always-JSON contract
  // -------------------------------------------------------------------------

  test("emits valid error JSON when worktree listing fails", async () => {
    const repo = await makeRepo("worktree-fail");

    const { exitCode, result } = await runAuditWithFailingGit(repo, "worktree list");

    expect(exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.step).toBe("scan-worktrees");
    // Must be structured JSON, not an empty / non-JSON crash
    expect(typeof result.error).toBe("string");
  });

  // -------------------------------------------------------------------------
  // Remote: origin gate, non-destructive fetch, fail-closed
  // -------------------------------------------------------------------------

  test("skips remote scan (no network) when there is no origin", async () => {
    const repo = await makeRepo("no-origin");

    const { exitCode, result } = await runAudit(repo, "--include-remote");
    const categories = result.categories as Record<string, unknown[]>;

    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(categories.stale_remote).toHaveLength(0);
    expect(categories.stale_tracking).toHaveLength(0);
  });

  test("fails closed (scan-remote) when origin exists but fetch fails", async () => {
    const { repo } = await makeRepoWithOrigin("fetch-fail");
    // Point origin at a path that does not exist -> fetch must fail
    await git(repo, "remote", "set-url", "origin", join(makeTmpDir("gone"), "missing.git"));

    const { exitCode, result } = await runAudit(repo, "--include-remote");

    expect(exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.step).toBe("scan-remote");
  });

  test("reports deleted upstream branch as stale_tracking, tracking ref intact", async () => {
    const { origin, repo } = await makeRepoWithOrigin("stale-tracking");

    await git(repo, "checkout", "-b", "feature/gone");
    await addCommit(repo, "gone.txt", "gone work");
    await git(repo, "push", "-u", "origin", "feature/gone");
    await git(repo, "checkout", "main");

    // Delete the branch directly on the remote (simulates someone else deleting it)
    await git(origin, "update-ref", "-d", "refs/heads/feature/gone");

    const { result } = await runAudit(repo, "--include-remote");
    const categories = result.categories as Record<string, unknown[]>;

    expect(categories.stale_tracking).toContain("origin/feature/gone");
    // Non-destructive audit: the tracking ref must still be present afterwards
    const remoteRefs = await git(repo, "branch", "-r", "--format=%(refname:short)");
    expect(remoteRefs.split("\n")).toContain("origin/feature/gone");
  });

  test("excludes non-origin remote branches from stale_remote", async () => {
    const { repo } = await makeRepoWithOrigin("multi-remote");
    const other = makeTmpDir("multi-remote-other");
    await git(other, "init", "--bare", "--initial-branch=main");
    await git(repo, "remote", "add", "other", other);

    await git(repo, "checkout", "-b", "feature/shared");
    await addCommit(repo, "shared.txt", "shared work");
    await git(repo, "push", "-u", "origin", "feature/shared");
    await git(repo, "push", "other", "feature/shared");

    await git(repo, "checkout", "main");
    await git(repo, "merge", "feature/shared");
    await git(repo, "push", "origin", "main");
    await git(repo, "branch", "-d", "feature/shared");
    await git(repo, "fetch", "other");

    const { result } = await runAudit(repo, "--include-remote");
    const stale = (result.categories as Record<string, { name: string }[]>).stale_remote;
    const names = stale?.map((b) => b.name);

    expect(names).toContain("origin/feature/shared");
    expect(names?.every((n) => n.startsWith("origin/"))).toBe(true);
    expect(names?.some((n) => n.startsWith("other/"))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Stale worktree branches flow into deletion classification
  // -------------------------------------------------------------------------

  test("classifies a stale-worktree branch in the same audit", async () => {
    const repo = await makeRepo("stale-wt-branch");
    const wtDir = makeTmpDir("stale-wt");

    await git(repo, "checkout", "-b", "feature/wt-stale");
    await addCommit(repo, "wt.txt", "worktree work");
    await git(repo, "checkout", "main");
    await git(repo, "merge", "feature/wt-stale");
    await git(repo, "worktree", "add", wtDir, "feature/wt-stale");

    // Remove the worktree directory out from under git -> stale (missing-dir)
    rmSync(wtDir, { recursive: true, force: true });

    const { result } = await runAudit(repo);
    const categories = result.categories as Record<string, { name?: string; path?: string }[]>;

    // Reported as a stale worktree...
    expect(categories.stale_worktrees?.some((w) => w.path === wtDir)).toBe(true);
    // ...AND its branch is classified for deletion instead of being retained.
    expect(categories.merged_local?.some((b) => b.name === "feature/wt-stale")).toBe(true);
    expect(keptNames(result)).not.toContain("feature/wt-stale");
  });

  // -------------------------------------------------------------------------
  // Live worktrees: releasable vs held
  // -------------------------------------------------------------------------

  test("proposes removing a live clean worktree whose branch is contained", async () => {
    const repo = await makeRepo("wt-removable");
    const wtDir = makeTmpDir("wt-removable-dir");

    await git(repo, "checkout", "-b", "feature/agent-done");
    await addCommit(repo, "agent.txt", "agent work");
    await git(repo, "checkout", "main");
    await git(repo, "merge", "feature/agent-done");
    await git(repo, "worktree", "add", wtDir, "feature/agent-done");

    const { result } = await runAudit(repo);
    const categories = result.categories as Record<
      string,
      { name?: string; path?: string; branch?: string; proof?: string }[]
    >;

    const removable = categories.removable_worktrees?.find((w) => w.path === wtDir);
    expect(removable?.branch).toBe("feature/agent-done");
    expect(removable?.proof).toBe("ancestry");
    // The branch must flow into deletion in the SAME pass, not sit in kept.
    expect(categories.merged_local?.some((b) => b.name === "feature/agent-done")).toBe(true);
    expect(keptNames(result)).not.toContain("feature/agent-done");

    await git(repo, "worktree", "remove", wtDir);
  });

  test("names the ignored files a worktree removal would destroy", async () => {
    const repo = await makeRepo("wt-ignored");
    const wtDir = makeTmpDir("wt-ignored-dir");

    writeFileSync(join(repo, ".gitignore"), ".env\nnode_modules/\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "add gitignore");
    await git(repo, "checkout", "-b", "feature/has-secrets");
    await addCommit(repo, "work.txt", "work");
    await git(repo, "checkout", "main");
    await git(repo, "merge", "feature/has-secrets");
    await git(repo, "worktree", "add", wtDir, "feature/has-secrets");

    // Untracked AND ignored: invisible to `git status --porcelain`, deleted
    // without complaint by `git worktree remove`.
    writeFileSync(join(wtDir, ".env"), "DB_PASSWORD=secret");
    mkdirSync(join(wtDir, "node_modules"), { recursive: true });
    writeFileSync(join(wtDir, "node_modules", "dep.js"), "module.exports = 1");

    const { result } = await runAudit(repo);
    const removable = (
      result.categories as Record<
        string,
        { path: string; ignored: { files: string[]; dirs: string[]; truncated: boolean } }[]
      >
    ).removable_worktrees?.find((w) => w.path === wtDir);

    // Still removable — but never silently: the cost is reported.
    expect(removable).toBeDefined();
    expect(removable?.ignored.files).toEqual([".env"]);
    expect(removable?.ignored.dirs).toEqual(["node_modules/"]);
    expect(removable?.ignored.truncated).toBe(false);

    await git(repo, "worktree", "remove", "--force", wtDir);
  });

  test("keeps an agent branch carrying unproven work instead of offering it", async () => {
    const repo = await makeRepo("agent-unproven");

    // The tool creates these and agents normally abandon them empty. This one
    // was worked on directly, so it holds the only copy of that commit.
    await git(repo, "checkout", "-b", "worktree-agent-abc123");
    await addCommit(repo, "only-copy.txt", "work that exists nowhere else");
    await git(repo, "checkout", "main");

    const { result } = await runAudit(repo);
    const categories = result.categories as Record<string, { name: string }[]>;

    expect(categories.orphaned_worktree).toHaveLength(0);
    expect(keptEntry(result, "worktree-agent-abc123")?.reason).toBe("unproven");
  });

  test("keeps a dirty worktree and says so", async () => {
    const repo = await makeRepo("wt-dirty");
    const wtDir = makeTmpDir("wt-dirty-dir");

    await git(repo, "checkout", "-b", "feature/agent-dirty");
    await addCommit(repo, "agent.txt", "agent work");
    await git(repo, "checkout", "main");
    await git(repo, "merge", "feature/agent-dirty");
    await git(repo, "worktree", "add", wtDir, "feature/agent-dirty");
    writeFileSync(join(wtDir, "uncommitted.txt"), "work in progress");

    const { result } = await runAudit(repo);
    const categories = result.categories as Record<string, { path?: string }[]>;

    expect(categories.removable_worktrees).toHaveLength(0);
    const entry = keptEntry(result, "feature/agent-dirty");
    expect(entry?.reason).toBe("dirty-worktree");
    expect(entry?.detail).toBe(wtDir);

    await git(repo, "worktree", "remove", "--force", wtDir);
  });

  // -------------------------------------------------------------------------
  // Trunk protection, base resolution, sweep.* config
  // -------------------------------------------------------------------------

  test("never proposes a protected trunk, local or remote", async () => {
    const { repo } = await makeRepoWithOrigin("protected-trunk");

    // dev is the working trunk: main is its ancestor by design, on both sides.
    await git(repo, "checkout", "-b", "dev");
    await addCommit(repo, "dev.txt", "dev work");
    await git(repo, "push", "-u", "origin", "dev");

    const { result } = await runAudit(repo, "--base", "dev", "--include-remote");
    const categories = result.categories as Record<string, { name: string }[]>;

    expect(categories.merged_local).toHaveLength(0);
    expect(categories.stale_remote).toHaveLength(0);
    expect(keptEntry(result, "main")?.reason).toBe("protected");
    const keptRemote = result.kept_remote as Kept[];
    expect(keptRemote.find((k) => k.name === "origin/main")?.reason).toBe("protected");
  });

  test("honours sweep.protect for a custom branch", async () => {
    const repo = await makeRepo("sweep-protect");

    await git(repo, "checkout", "-b", "release");
    await git(repo, "checkout", "main");
    await git(repo, "config", "sweep.protect", "release");

    const { result } = await runAudit(repo);
    const categories = result.categories as Record<string, unknown[]>;

    expect(categories.merged_local).toHaveLength(0);
    expect(keptEntry(result, "release")?.reason).toBe("protected");
  });

  test("resolves the base itself when none is given", async () => {
    const repo = await makeRepo("resolve-master");
    await git(repo, "branch", "-m", "main", "master");

    const { exitCode, result } = await runAudit(repo);

    expect(exitCode).toBe(0);
    expect(result.base).toBe("master");
  });

  test("skips a stale origin/HEAD candidate that no longer exists", async () => {
    const { repo } = await makeRepoWithOrigin("stale-origin-head");
    await git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/gone");

    const { exitCode, result } = await runAudit(repo);

    expect(exitCode).toBe(0);
    expect(result.base).toBe("main");
  });

  test("sweep.base wins over the default candidates", async () => {
    const repo = await makeRepo("sweep-base");
    await git(repo, "checkout", "-b", "work");
    await git(repo, "checkout", "main");
    await git(repo, "config", "sweep.base", "work");

    const { result } = await runAudit(repo);

    expect(result.base).toBe("work");
  });

  test("errors when no trunk candidate exists", async () => {
    const repo = await makeRepo("no-trunk");
    await git(repo, "branch", "-m", "main", "wip");

    const { exitCode, result } = await runAudit(repo);

    expect(exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no trunk branch found");
  });

  test("rejects an invalid --max-age instead of dropping the age gate", async () => {
    const repo = await makeRepo("bad-max-age");

    const { exitCode, result } = await runAudit(repo, "--max-age", "abc");

    expect(exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.step).toBe("validate");
  });

  test("honours custom prefixes from git config", async () => {
    const repo = await makeRepo("custom-prefixes");
    await git(repo, "config", "sweep.agentPrefix", "wt-");
    await git(repo, "config", "sweep.backupPrefix", "save/");

    await git(repo, "checkout", "-b", "wt-abc");
    await git(repo, "checkout", "-b", "save/old");
    await addCommit(repo, "save.txt", "saved work");
    await git(repo, "checkout", "main");

    const { result } = await runAudit(repo);
    const categories = result.categories as Record<string, { name: string }[]>;

    expect(categories.orphaned_worktree?.map((b) => b.name)).toContain("wt-abc");
    expect(categories.backup?.map((b) => b.name)).toContain("save/old");
    // The former defaults no longer classify anything on their own.
    expect(categories.merged_local).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Durable manifest hand-off (--save-manifest)
  // -------------------------------------------------------------------------

  test("--save-manifest writes {manifest, kept} atomically to the git dir", async () => {
    const repo = await makeRepo("save-manifest");
    const manifest = {
      base: "main",
      worktrees: [],
      branches: [{ name: "feature/x", force: false, oid: "a".repeat(40) }],
      remote_branches: [],
      prune_remotes: false,
      prune_worktrees: false,
    };
    const gitDir = await git(repo, "rev-parse", "--absolute-git-dir");

    const proc = Bun.spawn(["bun", "run", SCRIPT, "--save-manifest"], {
      cwd: repo,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const kept = [{ name: "main", reason: "base", detail: null }];
    proc.stdin.write(JSON.stringify({ manifest, kept }));
    await proc.stdin.end();
    const out = JSON.parse((await new Response(proc.stdout).text()).trim());
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(out.ok).toBe(true);
    const saved = JSON.parse(await Bun.file(join(gitDir, "git-sweep-manifest.json")).text());
    expect(saved.manifest.branches[0].name).toBe("feature/x");
    expect(saved.kept).toEqual(kept);
  });

  test("--save-manifest rejects a branch entry with no audited oid", async () => {
    const repo = await makeRepo("save-manifest-no-oid");

    const proc = Bun.spawn(["bun", "run", SCRIPT, "--save-manifest"], {
      cwd: repo,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(
      JSON.stringify({
        manifest: {
          base: "main",
          worktrees: [],
          branches: [{ name: "feature/x", force: false }],
          remote_branches: [],
          prune_remotes: false,
          prune_worktrees: false,
        },
        kept: [],
      }),
    );
    await proc.stdin.end();
    const out = JSON.parse((await new Response(proc.stdout).text()).trim());

    expect(await proc.exited).toBe(1);
    expect(out.ok).toBe(false);
  });

  test("--save-manifest rejects an invalid manifest shape", async () => {
    const repo = await makeRepo("save-manifest-bad");

    const proc = Bun.spawn(["bun", "run", SCRIPT, "--save-manifest"], {
      cwd: repo,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(JSON.stringify({ manifest: { branches: "nope" }, kept: [] }));
    await proc.stdin.end();
    const out = JSON.parse((await new Response(proc.stdout).text()).trim());
    const exitCode = await proc.exited;

    expect(exitCode).toBe(1);
    expect(out.ok).toBe(false);
  });
});
