import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "git-clean-apply.ts");

let tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const safe = prefix.replace(/[^a-zA-Z0-9-]/g, "-");
  const dir = mkdtempSync(join(tmpdir(), `git-clean-apply-test-${safe}-`));
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

async function runApply(
  cwd: string,
  ...args: string[]
): Promise<{ exitCode: number; result: Record<string, unknown> }> {
  const proc = Bun.spawn(["bun", "run", SCRIPT, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  try {
    return { exitCode, result: JSON.parse(stdout.trim()) };
  } catch {
    return { exitCode, result: { ok: false, error: `parse-error: ${stdout.trim()}` } };
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
  await git(origin, "init", "--bare", "--initial-branch=main");
  const repo = await makeRepo(prefix);
  await git(repo, "remote", "add", "origin", origin);
  await git(repo, "push", "-u", "origin", "main");
  return { origin, repo };
}

async function addCommit(repo: string, filename: string, message: string): Promise<void> {
  writeFileSync(join(repo, filename), message);
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", message);
}

type ManifestParts = {
  base?: string;
  worktrees?: string[];
  branches?: { name: string; force: boolean; oid: string }[];
  remote_branches?: { remote: string; ref: string; oid: string }[];
  prune_remotes?: boolean;
  prune_worktrees?: boolean;
};

// Writes a {manifest, kept} hand-off file and returns its path.
function writeManifest(repo: string, parts: ManifestParts, name = "manifest.json"): string {
  const path = join(repo, name);
  writeFileSync(
    path,
    JSON.stringify({
      manifest: {
        base: "main",
        worktrees: [],
        branches: [],
        remote_branches: [],
        prune_remotes: false,
        prune_worktrees: false,
        ...parts,
      },
      kept: [{ name: "main", reason: "base", detail: null }],
    }),
  );
  return path;
}

const opFor = (result: Record<string, unknown>, target: string) =>
  (result.operations as { target: string; success: boolean; error: string | null }[]).find(
    (op) => op.target === target,
  );

describe("git-clean-apply", () => {
  test("--manifest-file executes and consumes the file on success", async () => {
    const repo = await makeRepo("manifest-file");

    // A merged branch that is safe to delete with `git branch -d`
    await git(repo, "checkout", "-b", "feature/done");
    writeFileSync(join(repo, "f.txt"), "feature");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "feature work");
    await git(repo, "checkout", "main");
    await git(repo, "merge", "feature/done");

    const oid = await git(repo, "rev-parse", "feature/done");
    const manifestFile = writeManifest(repo, {
      branches: [{ name: "feature/done", force: false, oid }],
    });

    const { exitCode, result } = await runApply(repo, "--manifest-file", manifestFile);

    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect((result.summary as { succeeded: number }).succeeded).toBe(1);

    // Branch is gone
    const branches = await git(repo, "branch", "--format=%(refname:short)");
    expect(branches.split("\n")).not.toContain("feature/done");

    // File is consumed on success
    expect(existsSync(manifestFile)).toBe(false);
  });

  test("--manifest-file with an invalid shape fails with a structured error", async () => {
    const repo = await makeRepo("manifest-file-bad");

    const manifestFile = join(repo, "bad.json");
    writeFileSync(
      manifestFile,
      JSON.stringify({ manifest: { branches: "not-an-array" }, kept: [] }),
    );

    const { exitCode, result } = await runApply(repo, "--manifest-file", manifestFile);

    expect(exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
    // Invalid input must NOT be consumed (left in place for inspection/retry)
    expect(existsSync(manifestFile)).toBe(true);
  });

  test("force deletes an unmerged branch with -D", async () => {
    const repo = await makeRepo("force-delete");

    await git(repo, "checkout", "-b", "worktree-agent-abc");
    await addCommit(repo, "agent.txt", "unmerged agent work");
    await git(repo, "checkout", "main");

    const oid = await git(repo, "rev-parse", "worktree-agent-abc");
    const manifestFile = writeManifest(repo, {
      branches: [{ name: "worktree-agent-abc", force: true, oid }],
    });

    const { result } = await runApply(repo, "--manifest-file", manifestFile);

    expect(result.ok).toBe(true);
    const branches = await git(repo, "branch", "--format=%(refname:short)");
    expect(branches.split("\n")).not.toContain("worktree-agent-abc");
  });

  // -------------------------------------------------------------------------
  // Duplicate entries
  // -------------------------------------------------------------------------

  test("collapses an identical duplicate instead of failing on the second pass", async () => {
    const repo = await makeRepo("dup-identical");

    await git(repo, "checkout", "-b", "feature/twice");
    await addCommit(repo, "t.txt", "work");
    await git(repo, "checkout", "main");
    await git(repo, "merge", "feature/twice");
    const oid = await git(repo, "rev-parse", "feature/twice");

    // The audit legitimately reports a branch held by a removable worktree in
    // two categories, so a manifest can name it twice.
    const entry = { name: "feature/twice", force: false, oid };
    const manifestFile = writeManifest(repo, { branches: [entry, entry] });

    const { exitCode, result } = await runApply(repo, "--manifest-file", manifestFile);

    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.summary as { succeeded: number; failed: number }).toEqual({
      succeeded: 1,
      failed: 0,
    });
    expect(existsSync(manifestFile)).toBe(false);
  });

  test("refuses a manifest naming one branch with conflicting flags", async () => {
    const repo = await makeRepo("dup-conflict");

    await git(repo, "checkout", "-b", "feature/conflicted");
    await addCommit(repo, "c.txt", "work");
    await git(repo, "checkout", "main");
    await git(repo, "merge", "feature/conflicted");
    const oid = await git(repo, "rev-parse", "feature/conflicted");

    const manifestFile = writeManifest(repo, {
      branches: [
        { name: "feature/conflicted", force: false, oid },
        { name: "feature/conflicted", force: true, oid },
      ],
    });

    const { exitCode, result } = await runApply(repo, "--manifest-file", manifestFile);

    expect(exitCode).toBe(1);
    expect(result.error).toContain("conflicting branch entries");
    // Nothing ran: the branch is untouched and the file is left for inspection.
    const branches = await git(repo, "branch", "--format=%(refname:short)");
    expect(branches.split("\n")).toContain("feature/conflicted");
    expect(existsSync(manifestFile)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Guards the manifest cannot waive
  // -------------------------------------------------------------------------

  test("refuses to delete the base branch even when the manifest asks", async () => {
    const repo = await makeRepo("guard-base");

    await git(repo, "checkout", "-b", "side");
    const oid = await git(repo, "rev-parse", "main");
    const manifestFile = writeManifest(repo, {
      branches: [{ name: "main", force: true, oid }],
    });

    const { exitCode, result } = await runApply(repo, "--manifest-file", manifestFile);

    expect(exitCode).toBe(1);
    expect(opFor(result, "main")?.error).toContain("base branch");
    const branches = await git(repo, "branch", "--format=%(refname:short)");
    expect(branches.split("\n")).toContain("main");
  });

  test("refuses to delete a branch that moved since the audit", async () => {
    const repo = await makeRepo("guard-oid");

    await git(repo, "checkout", "-b", "feature/moving");
    await addCommit(repo, "m.txt", "first");
    await git(repo, "checkout", "main");
    await git(repo, "merge", "feature/moving");
    const audited = await git(repo, "rev-parse", "feature/moving");

    // New work lands on the branch after the audit proved containment.
    await git(repo, "checkout", "feature/moving");
    await addCommit(repo, "m2.txt", "work added after the audit");
    await git(repo, "checkout", "main");

    const manifestFile = writeManifest(repo, {
      branches: [{ name: "feature/moving", force: true, oid: audited }],
    });

    const { exitCode, result } = await runApply(repo, "--manifest-file", manifestFile);

    expect(exitCode).toBe(1);
    expect(opFor(result, "feature/moving")?.error).toContain("moved since the audit");
    const branches = await git(repo, "branch", "--format=%(refname:short)");
    expect(branches.split("\n")).toContain("feature/moving");
  });

  // -------------------------------------------------------------------------
  // Worktrees
  // -------------------------------------------------------------------------

  test("removes a clean worktree but refuses a dirty one", async () => {
    const repo = await makeRepo("worktree-remove");
    const cleanDir = makeTmpDir("wt-clean");
    const dirtyDir = makeTmpDir("wt-dirty");

    await git(repo, "checkout", "-b", "feature/clean-wt");
    await git(repo, "checkout", "-b", "feature/dirty-wt");
    await git(repo, "checkout", "main");
    await git(repo, "worktree", "add", cleanDir, "feature/clean-wt");
    await git(repo, "worktree", "add", dirtyDir, "feature/dirty-wt");
    writeFileSync(join(dirtyDir, "wip.txt"), "uncommitted work");

    const manifestFile = writeManifest(repo, { worktrees: [cleanDir, dirtyDir] });
    const { result } = await runApply(repo, "--manifest-file", manifestFile);

    expect(opFor(result, cleanDir)?.success).toBe(true);
    // Uncommitted work is never discarded silently.
    expect(opFor(result, dirtyDir)?.success).toBe(false);
    expect(existsSync(join(dirtyDir, "wip.txt"))).toBe(true);

    await git(repo, "worktree", "remove", "--force", dirtyDir);
  });

  // -------------------------------------------------------------------------
  // Remote deletion under lease
  // -------------------------------------------------------------------------

  test("deletes a remote branch when it still points at the audited commit", async () => {
    const { repo } = await makeRepoWithOrigin("remote-ok");

    await git(repo, "checkout", "-b", "feature/remote-gone");
    await addCommit(repo, "r.txt", "remote work");
    await git(repo, "push", "-u", "origin", "feature/remote-gone");
    await git(repo, "checkout", "main");
    const oid = await git(repo, "rev-parse", "feature/remote-gone");

    const manifestFile = writeManifest(repo, {
      remote_branches: [{ remote: "origin", ref: "feature/remote-gone", oid }],
    });
    const { result } = await runApply(repo, "--manifest-file", manifestFile);

    expect(result.ok).toBe(true);
    const remoteRefs = await git(repo, "ls-remote", "--heads", "origin");
    expect(remoteRefs).not.toContain("feature/remote-gone");
  });

  test("refuses to delete a remote branch that advanced since the audit", async () => {
    const { origin, repo } = await makeRepoWithOrigin("remote-advanced");

    await git(repo, "checkout", "-b", "feature/busy");
    await addCommit(repo, "b.txt", "first push");
    await git(repo, "push", "-u", "origin", "feature/busy");
    const audited = await git(repo, "rev-parse", "feature/busy");

    // Someone else pushes to the same branch after the audit.
    const clone = makeTmpDir("remote-advanced-clone");
    await git(clone, "clone", origin, clone);
    await git(clone, "config", "user.email", "test@test.com");
    await git(clone, "config", "user.name", "Test");
    await git(clone, "checkout", "feature/busy");
    await addCommit(clone, "theirs.txt", "work from someone else");
    await git(clone, "push", "origin", "feature/busy");

    await git(repo, "checkout", "main");
    const manifestFile = writeManifest(repo, {
      remote_branches: [{ remote: "origin", ref: "feature/busy", oid: audited }],
    });
    const { exitCode, result } = await runApply(repo, "--manifest-file", manifestFile);

    expect(exitCode).toBe(1);
    expect(opFor(result, "origin/feature/busy")?.success).toBe(false);
    // Their commit survives.
    const remoteRefs = await git(repo, "ls-remote", "--heads", "origin");
    expect(remoteRefs).toContain("feature/busy");
  });

  // -------------------------------------------------------------------------
  // Partial failure
  // -------------------------------------------------------------------------

  test("rewrites the hand-off file with only the failed operations", async () => {
    const repo = await makeRepo("partial");

    await git(repo, "checkout", "-b", "feature/ok");
    await addCommit(repo, "ok.txt", "mergeable work");
    await git(repo, "checkout", "main");
    await git(repo, "merge", "feature/ok");
    const okOid = await git(repo, "rev-parse", "feature/ok");

    // A second branch whose recorded oid is stale -> its delete must fail.
    await git(repo, "checkout", "-b", "feature/stale-oid");
    await addCommit(repo, "s.txt", "first");
    const staleOid = await git(repo, "rev-parse", "feature/stale-oid");
    await addCommit(repo, "s2.txt", "second");
    await git(repo, "checkout", "main");

    const manifestFile = writeManifest(repo, {
      branches: [
        { name: "feature/ok", force: false, oid: okOid },
        { name: "feature/stale-oid", force: true, oid: staleOid },
      ],
    });

    const { exitCode, result } = await runApply(repo, "--manifest-file", manifestFile);

    expect(exitCode).toBe(1);
    expect(result.summary as { succeeded: number; failed: number }).toEqual({
      succeeded: 1,
      failed: 1,
    });

    // The file survives, holding ONLY what is left to do.
    expect(existsSync(manifestFile)).toBe(true);
    expect(result.manifest_remaining).toEqual({ path: manifestFile, operations: 1 });
    const saved = JSON.parse(await Bun.file(manifestFile).text());
    expect(saved.manifest.branches).toHaveLength(1);
    expect(saved.manifest.branches[0].name).toBe("feature/stale-oid");
    expect(saved.manifest.base).toBe("main");
    // The kept list is carried over so a follow-up still reports it.
    expect(saved.kept[0].name).toBe("main");
  });
});
