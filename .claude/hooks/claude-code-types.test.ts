import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stubbedEnv, write } from "../../scripts/claude-code-types.fixture.ts";
import {
  type Outcome,
  RUN_GUARD,
  runState,
  statePaths,
  TYPES_PATH,
} from "../../scripts/claude-code-types.ts";
import { holdLock } from "../../scripts/lib/flock.fixture.ts";

const HOOK = join(import.meta.dir, "claude-code-types.ts");

// The run a test starts ends at its regenerate step: the fixture's claude
// writes no types with stub/types-silent. That takes well past bun's default
// 5 s on a loaded machine, so the tests that start one say how long they wait.
const STARTS_A_RUN = { timeout: 20_000 };

// Records whether a call to claude came with the session's CLAUDECODE and with
// the user's own CLAUDE_CODE_OAUTH_TOKEN, then
// hands over to the fixture's stub.
const SESSION_RECORDER = `#!/usr/bin/env bash
echo "\${CLAUDECODE:-unset} \${CLAUDE_CODE_OAUTH_TOKEN:-unset}" >>"$(dirname "$0")/../stub/sessions"
exec "$(dirname "$0")/claude-stub" "$@"
`;

let root = "";

let project = "";

let env: NodeJS.ProcessEnv = {};

const state = (name: string) => join(project, ".git", "claude-code-types", name);

const paths = () => statePaths(join(project, ".git"));

const recorded = (name: string) => {
  const file = join(root, "stub", name);

  return existsSync(file) ? readFileSync(file, "utf8") : "";
};

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });

  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);

  return result.stdout.toString().trim();
}

async function runHook(installed: string, cwd = project, extra: NodeJS.ProcessEnv = {}) {
  write(join(root, "stub", "version"), installed);

  const proc = Bun.spawn([process.execPath, HOOK], {
    stdin: new Blob([JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd })]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...env, ...extra },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

/** True once a run the hook started has ended: it frees its lock after its outcome and its notification. */
const runOver = () => existsSync(state("outcome.json")) && runState(paths()).kind === "idle";

/** The outcome of the run the hook started, once that run is over. */
async function runOutcome(): Promise<Outcome> {
  for (let tries = 0; tries < 150 && !runOver(); tries++) await Bun.sleep(100);

  // SAFETY: the pipeline writes this file from an Outcome.
  return JSON.parse(readFileSync(state("outcome.json"), "utf8")) as Outcome;
}

const message = (text: string) => JSON.stringify({ systemMessage: text });

function landTypes(header: string) {
  write(join(project, TYPES_PATH), `${header}\n// declarations\n`);
  git(project, "add", "-A");
  git(project, "commit", "-qm", "types");
  git(project, "push", "-q", "-u", "origin", "dev");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claude-code-types-hook-"));
  project = join(root, "project");
  env = {
    ...stubbedEnv(root),
    CLAUDE_PROJECT_DIR: project,
    CLAUDECODE: "1",
    CLAUDE_CODE_OAUTH_TOKEN: "token",
  };
  renameSync(join(root, "bin", "claude"), join(root, "bin", "claude-stub"));
  write(join(root, "bin", "claude"), SESSION_RECORDER);
  chmodSync(join(root, "bin", "claude"), 0o755);
  write(join(root, "stub", "types-silent"), "");

  git(root, "init", "-q", "--bare", join(root, "origin.git"));
  mkdirSync(project);
  git(project, "init", "-q", "-b", "dev");
  git(project, "remote", "add", "origin", join(root, "origin.git"));
  landTypes("// Written by Claude Code 2.1.292.");
});

afterEach(async () => {
  const fixture = root;
  const watched = paths();

  // A run a failed test started still writes into the fixture.
  for (let tries = 0; tries < 40 && runState(watched).kind === "running"; tries++) {
    await Bun.sleep(100);
  }

  rmSync(fixture, { recursive: true, force: true });
});

describe("claude-code-types hook", () => {
  test(
    "starts the run detached, under its guard, without the session's identity but with the user's variables, and says so in a systemMessage alone",
    async () => {
      const { exitCode, stdout } = await runHook("2.1.294");

      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe(
        message(
          `Claude Code types 2.1.294: checking in the background, log: ${state("2.1.294.log")}`,
        ),
      );
      expect(await runOutcome()).toMatchObject({ kind: "failed", step: "regenerate" });
      expect(recorded("version-guards")).toBe("unset\n1\n");
      expect(recorded("sessions")).toBe("1 token\nunset token\nunset unset\n");
      expect(recorded("notify-calls")).toBe("");
    },
    STARTS_A_RUN,
  );

  test(
    "leaves to the run the call on a build older than origin/dev's types, which settles it",
    async () => {
      await runHook("2.1.290");

      expect(await runOutcome()).toMatchObject({ kind: "skipped", installed: "2.1.290" });
      expect(readFileSync(state("settled"), "utf8")).toBe("2.1.290");
    },
    STARTS_A_RUN,
  );

  test("returns at once in a session the run started", async () => {
    const { exitCode, stdout } = await runHook("2.1.294", project, { [RUN_GUARD]: "1" });

    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
    expect(recorded("version-guards")).toBe("");
  });

  test("starts nothing for a settled version", async () => {
    write(state("settled"), "2.1.294");

    const { stdout } = await runHook("2.1.294");

    expect(stdout).toBe("");
    expect(recorded("version-guards")).toBe("unset\n");
  });

  test("names the live run and the version it works for, settled or not", async () => {
    write(state("settled"), "2.1.294");
    write(state("run.lock"), "");
    const held = await holdLock(state("run.lock"));

    write(
      state("holder.json"),
      JSON.stringify({ pid: held.pid, startedAt: "2026-10-08T10:00:00Z", version: "2.1.293" }),
    );

    try {
      const { stdout } = await runHook("2.1.294");

      expect(stdout.trim()).toBe(
        message(
          `Claude Code types 2.1.293: a run is going since 2026-10-08T10:00:00Z, pid ${held.pid}, log: ${state("2.1.293.log")}; kill ${held.pid} stops it and its agent`,
        ),
      );
      expect(recorded("version-guards")).toBe("");
    } finally {
      await held.release();
    }
  });

  test("starts no run over a lock a dead run left, beyond its stale holder file", async () => {
    write(state("settled"), "2.1.294");
    write(state("run.lock"), "");
    write(state("holder.json"), JSON.stringify({ pid: 1, startedAt: "then", version: "2.1.293" }));

    const { stdout } = await runHook("2.1.294");

    expect(stdout).toBe("");
  });

  test("shows the last outcome once", async () => {
    write(state("settled"), "2.1.294");

    const last: Outcome = {
      kind: "pr",
      url: "https://github.com/o/r/pull/7",
      from: "2.1.292",
      to: "2.1.294",
      created: true,
    };

    write(state("outcome.json"), JSON.stringify(last));

    const first = await runHook("2.1.294");
    const second = await runHook("2.1.294");

    expect(first.stdout.trim()).toBe(
      message(
        "Claude Code types 2.1.292 → 2.1.294: pull request opened, https://github.com/o/r/pull/7",
      ),
    );
    expect(second.stdout).toBe("");
  });

  test("keeps the outcome's line when the check after it fails", async () => {
    write(
      state("outcome.json"),
      JSON.stringify({
        kind: "skipped",
        installed: "2.1.294",
        devHeader: "2.1.294",
        rollingHeader: null,
      }),
    );
    write(join(root, "stub", "version"), "two words");

    const proc = Bun.spawn([process.execPath, HOOK], {
      stdin: new Blob([JSON.stringify({ cwd: project })]),
      stdout: "pipe",
      env,
    });

    const stdout = await new Response(proc.stdout).text();

    expect(await proc.exited).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      systemMessage: [
        "Claude Code types 2.1.294: origin/dev carries 2.1.294, chore/claude-code-types has no open pull request; nothing to do.",
        "Claude Code types: the session check failed: `claude --version` printed an unknown format: two words (Claude Code)",
      ].join("\n"),
    });
  });

  test(
    "keeps its state in the repository around the payload's cwd, from a linked worktree",
    async () => {
      const linked = join(root, "linked");
      git(project, "worktree", "add", "-q", "-b", "feature/x", linked);
      mkdirSync(join(linked, "sub"));

      const { stdout } = await runHook("2.1.294", join(linked, "sub"));

      expect(stdout).toContain(`log: ${state("2.1.294.log")}`);
      expect(await runOutcome()).toMatchObject({ kind: "failed" });
    },
    STARTS_A_RUN,
  );

  test(
    "climbs out of another repository nested in the checkout",
    async () => {
      const nested = join(project, "plans");
      mkdirSync(join(nested, "sub"), { recursive: true });
      git(nested, "init", "-q");

      const { stdout } = await runHook("2.1.294", join(nested, "sub"));

      expect(stdout).toContain(`log: ${state("2.1.294.log")}`);
      expect(await runOutcome()).toMatchObject({ kind: "failed" });
    },
    STARTS_A_RUN,
  );

  test(
    "falls back to the project when the payload's cwd sits in an unrelated repository",
    async () => {
      const unrelated = join(root, "dotfiles");
      mkdirSync(unrelated);
      git(unrelated, "init", "-q");

      const { stdout } = await runHook("2.1.294", unrelated);

      expect(stdout).toContain(`log: ${state("2.1.294.log")}`);
      expect(await runOutcome()).toMatchObject({ kind: "failed" });
    },
    STARTS_A_RUN,
  );
});
