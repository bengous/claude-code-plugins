import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { messageOf } from "../lib/platform/pure.ts";
import { git, GitError, gitRead } from "./git.ts";

const PATH = process.env["PATH"];

let dirs: string[] = [];

afterEach(() => {
  process.env["PATH"] = PATH;

  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);

  return dir;
}

/** A repository holding one commit, named to git with `-C`. */
function repo(): string {
  const dir = tmp("git-sweep-git-");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

  for (const args of [
    ["init", "-q"],
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one"],
  ]) {
    Bun.spawnSync(["git", ...args], { cwd: dir, env });
  }

  return dir;
}

/** Puts first on the PATH a git that runs the real one, then leaves a `sleep` holding its pipes past the platform's grace. */
function holdGitPipes(): void {
  const bin = tmp("git-sweep-holding-");
  const program = join(bin, "git");

  writeFileSync(program, `#!/bin/sh\n'${Bun.which("git")}' "$@"\ncode=$?\nsleep 3 &\nexit $code\n`);
  chmodSync(program, 0o755);
  process.env["PATH"] = `${bin}:${PATH ?? ""}`;
}

describe("an output let go of past the grace", () => {
  test("git throws, never answering its exit code with an empty stdout", async () => {
    const dir = repo();
    holdGitPipes();

    const thrown = await git("-C", dir, "rev-parse", "HEAD").catch((cause: unknown) => cause);

    expect(thrown).toBeInstanceOf(GitError);
    expect(messageOf(thrown)).toBe(
      `git -C ${dir} rev-parse HEAD exited 0, its output let go of after 1000 ms`,
    );
  });

  test("gitRead throws, never answering an empty stdout", async () => {
    const dir = repo();
    holdGitPipes();

    const thrown = await gitRead("-C", dir, "branch", "--show-current").catch(
      (cause: unknown) => cause,
    );

    expect(thrown).toBeInstanceOf(GitError);
    expect(messageOf(thrown)).toBe(
      `git -C ${dir} branch --show-current exited 0, its output let go of after 1000 ms`,
    );
  });
});
