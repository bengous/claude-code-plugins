import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dayOf, sweepPaths } from "./auto-sweep.ts";

const HOOK = join(import.meta.dir, "auto-sweep.ts");

// The sweep a test starts runs detached, past bun's default 5 s on a loaded machine.
const STARTS_A_SWEEP = { timeout: 20_000 };

// Unset for the hook, so what the sweep reads is what the hook set.
const PROMPT_VARIABLES = new Set([
  "GIT_TERMINAL_PROMPT",
  "GH_PROMPT_DISABLED",
  "SSH_ASKPASS_REQUIRE",
]);

// A git that, on `worktree list`, which the sweep runs and the hook does not,
// records the prompt variables and the session it runs in, then holds the
// sweep 3 s.
const slowGit = (realGit: string, record: string): string => `#!/usr/bin/env bash
if [[ "$1 $2" == "worktree list" && ! -e "${record}" ]]; then
  echo "\${GIT_TERMINAL_PROMPT-}|\${GH_PROMPT_DISABLED-}|\${SSH_ASKPASS_REQUIRE-}|$(ps -o sess= -p $$)" >"${record}"
  sleep 3
fi
exec "${realGit}" "$@"
`;

const sessionOf = (pid: number): string =>
  Bun.spawnSync(["ps", "-o", "sess=", "-p", String(pid)])
    .stdout.toString()
    .trim();

let root = "";

let project = "";

let env: NodeJS.ProcessEnv = {};

const paths = () => sweepPaths(join(project, ".git"));

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });

  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);

  return result.stdout.toString().trim();
}

const branchExists = (name: string): boolean =>
  Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${name}`], {
    cwd: project,
    env,
  }).exitCode === 0;

async function runHook(cwd: string, projectDir = project, extra: NodeJS.ProcessEnv = {}) {
  const proc = Bun.spawn([process.execPath, HOOK], {
    stdin: new Blob([JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd })]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...env, CLAUDE_PROJECT_DIR: projectDir, ...extra },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

const log = (): string => (existsSync(paths().log) ? readFileSync(paths().log, "utf8") : "");

/** The log once the sweep the hook started printed its summary, its last output. */
async function sweptLog(): Promise<string> {
  for (let tries = 0; tries < 150 && !log().includes("auto-sweep against"); tries++) {
    await Bun.sleep(100);
  }

  return log();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "auto-sweep-hook-"));
  project = join(root, "project");
  env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !PROMPT_VARIABLES.has(name)),
    ),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };

  mkdirSync(project);
  git(project, "init", "-q", "-b", "main");
  writeFileSync(join(project, "README.md"), "a repository\n");
  git(project, "add", "-A");
  git(project, "commit", "-qm", "initial commit");
  git(project, "branch", "dev");
  git(project, "branch", "feature/landed");
});

afterEach(async () => {
  // A sweep a failed test started still writes into the fixture.
  if (existsSync(paths().log)) await sweptLog();
  rmSync(root, { recursive: true, force: true });
});

describe("auto-sweep hook", () => {
  test(
    "starts the sweep against dev detached from the main checkout, notes the day and appends its output to the log",
    async () => {
      // Without --base, the sweep would take this one.
      git(project, "config", "sweep.base", "main");

      const { exitCode, stdout } = await runHook(project);

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        systemMessage: `auto-sweep: sweeping local branches and agent worktrees against dev in the background, log: ${paths().log}`,
      });
      expect(readFileSync(paths().day, "utf8")).toBe(dayOf(new Date()));

      const swept = await sweptLog();

      expect(swept).toContain(`auto-sweep --base dev, in ${project}`);
      expect(swept).toContain("auto-sweep against dev\n");
      expect(swept).toContain("feature/landed (ancestry)");
      expect(branchExists("feature/landed")).toBe(false);
    },
    STARTS_A_SWEEP,
  );

  test(
    "returns before the sweep ends, which runs in a session of its own with every prompt off",
    async () => {
      const bin = join(root, "bin");
      const record = join(root, "sweep-env");
      mkdirSync(bin);
      writeFileSync(join(bin, "git"), slowGit(Bun.which("git") ?? "git", record), { mode: 0o755 });

      const started = performance.now();

      const { exitCode, stdout } = await runHook(project, project, {
        PATH: `${bin}:${env["PATH"] ?? ""}`,
      });

      expect(performance.now() - started).toBeLessThan(2_000);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("auto-sweep: sweeping");

      for (let tries = 0; tries < 50 && !existsSync(record); tries++) await Bun.sleep(100);
      const [terminal, gh, askpass, session] = readFileSync(record, "utf8").trim().split("|");

      expect([terminal, gh, askpass]).toEqual(["0", "1", "never"]);
      expect(session?.trim()).not.toBe(sessionOf(process.pid));
      expect(await sweptLog()).toContain("auto-sweep against dev\n");
    },
    STARTS_A_SWEEP,
  );

  test("starts nothing on a day it already started one", async () => {
    mkdirSync(paths().dir, { recursive: true });
    writeFileSync(paths().day, dayOf(new Date()));

    const { exitCode, stdout } = await runHook(project);

    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
    expect(existsSync(paths().log)).toBe(false);
    expect(branchExists("feature/landed")).toBe(true);
  });

  test(
    "starts again on a later day, appending to the log",
    async () => {
      mkdirSync(paths().dir, { recursive: true });
      writeFileSync(paths().day, "2000-01-01");
      writeFileSync(paths().log, "an earlier run\n");

      const { stdout } = await runHook(project);

      expect(stdout).toContain("auto-sweep: sweeping");
      expect(readFileSync(paths().day, "utf8")).toBe(dayOf(new Date()));
      expect(await sweptLog()).toStartWith("an earlier run\n--- ");
    },
    STARTS_A_SWEEP,
  );

  test("starts nothing from a linked worktree, whatever the project", async () => {
    const linked = join(root, "linked");
    git(project, "worktree", "add", "-q", "-b", "feature/x", linked);

    for (const projectDir of [linked, project]) {
      const { exitCode, stdout } = await runHook(linked, projectDir);

      expect(exitCode).toBe(0);
      expect(stdout).toBe("");
    }

    expect(existsSync(paths().dir)).toBe(false);
  });

  test("names its failure on one stderr line with a non-blocking exit", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside);

    const { exitCode, stdout, stderr } = await runHook(outside, outside);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toStartWith("auto-sweep: ");
  });
});

describe("dayOf", () => {
  test("is the local calendar day, zero-padded", () => {
    expect(dayOf(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});
