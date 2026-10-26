import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { write } from "../../scripts/claude-code-types.fixture.ts";
import { holdLock } from "../../scripts/lib/flock.fixture.ts";
import { runState } from "../../scripts/lib/headless-run.ts";
import { statePaths } from "../../scripts/renovate-agent.ts";
import { dayOf } from "./once-a-day.ts";

const HOOK = join(import.meta.dir, "renovate-agent.ts");

// A gh that lists no pull request: the run it starts ends at once.
const GH_STUB = `#!/usr/bin/env bash
echo "$*" >>"$(dirname "$0")/../gh-calls"
if [[ "$1 $2" == "pr list" ]]; then echo "[]"; fi
`;

let root = "";

let project = "";

let env: NodeJS.ProcessEnv = {};

const state = () => statePaths(join(project, ".git"));

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });

  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);

  return result.stdout.toString().trim();
}

async function runHook(cwd: string, projectDir = project) {
  const proc = Bun.spawn([process.execPath, HOOK], {
    stdin: new Blob([JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd })]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...env, CLAUDE_PROJECT_DIR: projectDir },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

/** Waits for the run the hook started to take its lock and let it go. */
async function runOver(): Promise<void> {
  for (let tries = 0; tries < 100 && !existsSync(state().runLog); tries++) await Bun.sleep(100);

  for (let tries = 0; tries < 100 && runState(state()).kind === "running"; tries++) {
    await Bun.sleep(100);
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "renovate-agent-hook-"));
  project = join(root, "project");
  const origin = join(root, "origin.git");
  write(join(root, "bin", "gh"), GH_STUB);
  chmodSync(join(root, "bin", "gh"), 0o755);

  env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
    PATH: `${join(root, "bin")}:${process.env["PATH"] ?? ""}`,
    // bun test computes dates in UTC without setting TZ, and the hook it spawns would read the
    // machine's zone: from midnight to the offset, the two days differ.
    TZ: "UTC",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };

  git(root, "init", "-q", "--bare", origin);
  mkdirSync(project);
  git(project, "init", "-q", "-b", "dev");
  write(join(project, "README.md"), "a repository\n");
  git(project, "add", "-A");
  git(project, "commit", "-qm", "initial commit");
  git(project, "remote", "add", "origin", origin);
  git(project, "push", "-q", "origin", "dev");
});

afterEach(async () => {
  // A run a test started still writes into the fixture.
  if (existsSync(state().spawnLog)) await runOver();
  rmSync(root, { recursive: true, force: true });
});

describe("renovate-agent hook", () => {
  test("starts the run from the main checkout once a day, and notes the day", async () => {
    const { exitCode, stdout } = await runHook(project);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      systemMessage: `Renovate agent: checking the open Renovate pull requests in the background, log: ${state().runLog}`,
    });
    expect(readFileSync(state().day, "utf8")).toBe(dayOf(new Date()));

    await runOver();

    expect(readFileSync(join(root, "gh-calls"), "utf8")).toContain("pr list --author app/renovate");

    const again = await runHook(project);

    expect(again.stdout).toBe("");
  });

  test("shows the run's lines once, even on a day it starts nothing", async () => {
    mkdirSync(state().dir, { recursive: true });
    write(state().day, dayOf(new Date()));
    write(state().report, '"Renovate #7 (x): landed"\n"Renovate #8 (y) needs you"\n');

    const { stdout } = await runHook(project);

    expect(JSON.parse(stdout)).toEqual({
      systemMessage: "Renovate #7 (x): landed\nRenovate #8 (y) needs you",
    });
    expect((await runHook(project)).stdout).toBe("");
  });

  test("starts nothing while a run holds the lock, and keeps the day free", async () => {
    mkdirSync(state().dir, { recursive: true });
    const held = await holdLock(state().lock);

    try {
      expect((await runHook(project)).stdout).toBe("");
      expect(existsSync(state().day)).toBe(false);
    } finally {
      await held.release();
    }
  });

  test("starts nothing from a linked worktree, whatever the project", async () => {
    const linked = join(root, "linked");
    git(project, "worktree", "add", "-q", "-b", "feature/x", linked);

    for (const projectDir of [linked, project]) {
      const { exitCode, stdout } = await runHook(linked, projectDir);

      expect(exitCode).toBe(0);
      expect(stdout).toBe("");
    }

    expect(existsSync(state().dir)).toBe(false);
  });

  test("names its failure on one stderr line with a non-blocking exit", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside);

    const { exitCode, stdout, stderr } = await runHook(outside, outside);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toStartWith("renovate-agent: ");
  });
});
