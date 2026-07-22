import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = existsSync(join(import.meta.dir, "git-clean-apply"))
  ? join(import.meta.dir, "git-clean-apply")
  : join(import.meta.dir, "executable_git-clean-apply");

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

async function runApply(cwd: string, ...args: string[]): Promise<{ exitCode: number; result: Record<string, unknown> }> {
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

    const manifestFile = join(repo, "manifest.json");
    writeFileSync(
      manifestFile,
      JSON.stringify({
        manifest: {
          worktrees: [],
          branches: [{ name: "feature/done", force: false }],
          remote_branches: [],
          prune_remotes: false,
          prune_worktrees: false,
        },
        kept: ["main"],
      }),
    );

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
    writeFileSync(manifestFile, JSON.stringify({ manifest: { branches: "not-an-array" }, kept: [] }));

    const { exitCode, result } = await runApply(repo, "--manifest-file", manifestFile);

    expect(exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
    // Invalid input must NOT be consumed (left in place for inspection/retry)
    expect(existsSync(manifestFile)).toBe(true);
  });
});
