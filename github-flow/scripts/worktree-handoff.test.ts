/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- this harness asserts on the JSON that worktree-handoff.ts prints on stdout: a wrong shape has to fail an assertion rather than the compiler. */

import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { detectInstall, parseArgs } from "./worktree-handoff.ts";

const SCRIPT = join(import.meta.dir, "worktree-handoff.ts");

let tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  tmpDirs = [];
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout, stderr, exitCode } = await $`git ${args}`.cwd(cwd).quiet().nothrow();
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr.toString().trim()}`);
  }
  return stdout.toString().trim();
}

async function run(
  cwd: string,
  args: string[],
): Promise<{ exitCode: number; result: Record<string, unknown> }> {
  const { stdout, exitCode } = await $`bun run ${SCRIPT} ${args}`.cwd(cwd).quiet().nothrow();
  const out = stdout.toString().trim();
  try {
    return { exitCode, result: JSON.parse(out) };
  } catch {
    return { exitCode, result: { ok: false, error: `parse-error: ${out}` } };
  }
}

/**
 * A clone at <tmp>/repo of a bare origin, with `main` and `origin/layer-1`,
 * and a gitignored `.gh/handoffs/layer-2.md`.
 */
async function makeRepo(): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), "worktree-handoff-"));
  tmpDirs.push(tmp);
  const origin = join(tmp, "origin.git");
  await git(tmp, "init", "--bare", "--initial-branch=main", origin);
  const repo = join(tmp, "repo");
  await git(tmp, "clone", "--quiet", origin, repo);
  await git(repo, "config", "user.email", "test@test.com");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "commit.gpgsign", "false");
  await Bun.write(join(repo, ".gitignore"), ".gh/\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "init");
  await git(repo, "push", "-q", "origin", "main");
  await git(repo, "switch", "-qc", "layer-1");
  await Bun.write(join(repo, "layer-1.txt"), "layer 1\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "layer 1");
  await git(repo, "push", "-q", "origin", "layer-1");
  await git(repo, "switch", "-q", "main");
  await mkdir(join(repo, ".gh", "handoffs"), { recursive: true });
  await Bun.write(join(repo, ".gh", "handoffs", "layer-2.md"), "# Handoff layer-2\n");
  await Bun.write(join(repo, ".gh", "README.md"), "- [ ] layer-2\n");
  return repo;
}

describe("parseArgs", () => {
  test("branch and base are required", () => {
    expect(parseArgs([])).toEqual({ ok: false, error: "missing branch" });
    expect(parseArgs(["layer-2"]).ok).toBe(false);
    expect(parseArgs(["--base", "origin/x"]).ok).toBe(false);
  });

  test("options and repeatable --link", () => {
    const parsed = parseArgs([
      "layer-2",
      "--base",
      "origin/layer-1",
      "--link",
      ".env.local",
      "--link",
      ".dev.vars",
      "--install",
      "",
    ]);
    expect(parsed).toEqual({
      ok: true,
      options: {
        branch: "layer-2",
        base: "origin/layer-1",
        dir: ".gh",
        handoff: null,
        path: null,
        links: [".env.local", ".dev.vars"],
        install: { kind: "skip" },
      },
    });
  });

  test("install defaults to detection and keeps an explicit command", () => {
    const detect = parseArgs(["layer-2", "--base", "x"]);
    expect(detect.ok && detect.options.install).toEqual({ kind: "detect" });
    const command = parseArgs([
      "layer-2",
      "--base",
      "x",
      "--install",
      "bun install --frozen-lockfile",
    ]);
    expect(command.ok && command.options.install).toEqual({
      kind: "command",
      command: "bun install --frozen-lockfile",
    });
  });

  test("unknown option, missing value and a second positional are rejected", () => {
    expect(parseArgs(["layer-2", "--base", "x", "--launch"]).ok).toBe(false);
    expect(parseArgs(["layer-2", "--base"]).ok).toBe(false);
    expect(parseArgs(["layer-2", "layer-3", "--base", "x"]).ok).toBe(false);
  });
});

describe("detectInstall", () => {
  test("picks the command of the lockfile present", () => {
    expect(detectInstall(new Set(["pnpm-lock.yaml"]))).toBe("pnpm install");
    expect(detectInstall(new Set(["Cargo.lock"]))).toBe("cargo fetch");
    expect(detectInstall(new Set(["README.md"]))).toBeNull();
  });
});

describe("worktree-handoff.ts", () => {
  test("creates the worktree on the base, links the orchestration folder, excludes it", async () => {
    const repo = await makeRepo();
    const { exitCode, result } = await run(repo, [
      "layer-2",
      "--base",
      "origin/layer-1",
      "--install",
      "",
      "--link",
      ".env.local",
    ]);
    expect(result.ok).toBe(true);
    expect(exitCode).toBe(0);
    const worktree = result.worktree as string;
    expect(worktree).toBe(join(repo, "..", "repo-layer-2"));
    expect(result.linked).toBe(2);
    expect(result.links_missing).toEqual([".env.local"]);
    expect(result.install).toBeNull();

    expect(await git(worktree, "branch", "--show-current")).toBe("layer-2");
    expect(await git(worktree, "rev-parse", "HEAD")).toBe(
      await git(repo, "rev-parse", "origin/layer-1"),
    );
    expect(lstatSync(join(worktree, ".gh", "handoffs", "layer-2.md")).isSymbolicLink()).toBe(true);
    expect(await git(worktree, "status", "--porcelain")).toBe("");

    const exclude = await Bun.file(join(repo, ".git", "info", "exclude")).text();
    expect(exclude).toContain("\n.gh/\n");
  });

  test("a second run reuses the exclude line and refuses the existing branch", async () => {
    const repo = await makeRepo();
    await run(repo, ["layer-2", "--base", "origin/layer-1", "--install", ""]);
    const { result } = await run(repo, ["layer-2", "--base", "origin/layer-1", "--install", ""]);
    expect(result.error).toBe("branch-exists");
    const exclude = await Bun.file(join(repo, ".git", "info", "exclude")).text();
    expect(exclude.split("\n").filter((line) => line === ".gh/")).toHaveLength(1);
  });

  test("refuses a missing handoff and an unknown base", async () => {
    const repo = await makeRepo();
    const missing = await run(repo, ["layer-3", "--base", "origin/layer-1", "--install", ""]);
    expect(missing.result.error).toBe("handoff-missing");
    expect(missing.result.detail).toContain("layer-2.md");

    const badBase = await run(repo, ["layer-2", "--base", "origin/nope", "--install", ""]);
    expect(badBase.result.error).toBe("base-not-found");
    expect(badBase.result.detail).toContain("origin/layer-1");
  });

  test("refuses to run from a worktree", async () => {
    const repo = await makeRepo();
    const first = await run(repo, ["layer-2", "--base", "origin/layer-1", "--install", ""]);
    const worktree = first.result.worktree as string;
    await Bun.write(join(repo, ".gh", "handoffs", "layer-3.md"), "# Handoff layer-3\n");
    const { result } = await run(worktree, [
      "layer-3",
      "--base",
      "origin/layer-1",
      "--install",
      "",
    ]);
    expect(result.error).toBe("inside-a-worktree");
  });

  test("runs the install command through the shell, in the worktree", async () => {
    const repo = await makeRepo();
    const ok = await run(repo, [
      "layer-2",
      "--base",
      "origin/layer-1",
      "--install",
      "touch installed.txt",
    ]);
    expect(ok.result.install).toBe("touch installed.txt");
    expect(await Bun.file(join(ok.result.worktree as string, "installed.txt")).exists()).toBe(true);

    await Bun.write(join(repo, ".gh", "handoffs", "layer-3.md"), "# Handoff layer-3\n");
    const failed = await run(repo, ["layer-3", "--base", "origin/layer-1", "--install", "false"]);
    expect(failed.result.error).toBe("install-failed");
  });
});
