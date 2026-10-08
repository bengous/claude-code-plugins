import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { RUN_GUARD, TYPES_PATH, type Outcome } from "../../scripts/claude-code-types.ts";

const HOOK = join(import.meta.dir, "claude-code-types.ts");

// Stands in for `claude`: `--version` answers the version in stub/version and
// records the guard it saw; a `--plugin-dir` run writes no types, so a run the
// hook starts ends at its regenerate step, quickly, with a failed outcome.
const CLAUDE_STUB = `#!/usr/bin/env bash
set -euo pipefail
stub="$(dirname "$0")/../stub"
if [[ $1 == --version ]]; then
  echo "\${${RUN_GUARD}:-unset}" >>"$stub/version-guards"
  echo "$(cat "$stub/version") (Claude Code)"
  exit 0
fi
echo "stub: wrote nothing" >&2
exit 1
`;

let root = "";

let project = "";

let env: NodeJS.ProcessEnv = {};

const state = (name: string) => join(project, ".git", "claude-code-types", name);

const guards = () => {
  const file = join(root, "stub", "version-guards");

  return existsSync(file) ? readFileSync(file, "utf8") : "";
};

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

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

  return { exitCode, stdout, stderr, firstErrorLine: stderr.split("\n", 1)[0] ?? "" };
}

/** The outcome the started run writes, once it is there. */
async function runOutcome(): Promise<Outcome> {
  for (let tries = 0; tries < 100 && !existsSync(state("outcome.json")); tries++)
    await Bun.sleep(100);

  // SAFETY: the pipeline writes this file from an Outcome.
  return JSON.parse(readFileSync(state("outcome.json"), "utf8")) as Outcome;
}

const message = (text: string) => JSON.stringify({ systemMessage: text });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claude-code-types-hook-"));
  project = join(root, "project");
  const origin = join(root, "origin.git");
  write(
    join(root, "gitconfig"),
    "[user]\n\tname = t\n\temail = t@t\n[commit]\n\tgpgsign = false\n",
  );
  write(join(root, "bin", "claude"), CLAUDE_STUB);
  chmodSync(join(root, "bin", "claude"), 0o755);

  env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !name.startsWith("GIT_") && name !== RUN_GUARD,
      ),
    ),
    PATH: `${join(root, "bin")}:${process.env["PATH"] ?? ""}`,
    CLAUDE_PROJECT_DIR: project,
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };

  git(root, "init", "-q", "--bare", origin);
  mkdirSync(project);
  git(project, "init", "-q", "-b", "dev");
  git(project, "remote", "add", "origin", origin);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function landTypes(header: string) {
  write(join(project, TYPES_PATH), `${header}\n// declarations\n`);
  git(project, "add", "-A");
  git(project, "commit", "-qm", "types");
  git(project, "push", "-q", "-u", "origin", "dev");
}

describe("claude-code-types hook", () => {
  test("starts the run detached, under its guard, and says so in a systemMessage alone", async () => {
    landTypes("// Written by Claude Code 2.1.292.");

    const { exitCode, stdout } = await runHook("2.1.294");

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(
      message(
        `Claude Code types 2.1.292 → 2.1.294: checking in the background, log: ${state("run.log")}`,
      ),
    );
    expect(await runOutcome()).toMatchObject({ kind: "failed", step: "regenerate" });
    expect(guards()).toBe("unset\n1\n");
  });

  test("returns at once in a session the run started", async () => {
    landTypes("// Written by Claude Code 2.1.292.");

    const { exitCode, stdout } = await runHook("2.1.294", project, { [RUN_GUARD]: "1" });

    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
    expect(guards()).toBe("");
  });

  test("says nothing when origin/dev carries the installed types", async () => {
    landTypes("// Written by Claude Code 2.1.294.");

    const { exitCode, stdout } = await runHook("2.1.294");

    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });

  test("says nothing to an installed build older than origin/dev's types", async () => {
    landTypes("// Written by Claude Code 2.1.294.");

    const { stdout } = await runHook("2.1.290");

    expect(stdout).toBe("");
    expect(existsSync(state("run.lock"))).toBe(false);
  });

  test("names the live run instead of starting another", async () => {
    landTypes("// Written by Claude Code 2.1.292.");
    write(
      state("run.lock"),
      JSON.stringify({ pid: process.pid, startedAt: "2026-10-08T10:00:00Z" }),
    );

    const { stdout } = await runHook("2.1.294");

    expect(stdout.trim()).toBe(
      message(
        `Claude Code types 2.1.294: a run is going since 2026-10-08T10:00:00Z, pid ${process.pid}, log: ${state("run.log")}`,
      ),
    );
    expect(guards()).toBe("unset\n");
  });

  test("shows the last outcome once", async () => {
    landTypes("// Written by Claude Code 2.1.294.");

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

  test("reads the repository around the payload's cwd, from a linked worktree", async () => {
    landTypes("// Written by Claude Code 2.1.292.");
    const linked = join(root, "linked");
    git(project, "worktree", "add", "-q", "-b", "feature/x", linked);
    mkdirSync(join(linked, "sub"));

    const { stdout } = await runHook("2.1.294", join(linked, "sub"));

    expect(stdout).toContain("checking in the background");
    expect(await runOutcome()).toMatchObject({ kind: "failed" });
  });

  test("does nothing in a repository whose origin/dev carries no vellum types", async () => {
    write(join(project, "README.md"), "no types\n");
    git(project, "add", "-A");
    git(project, "commit", "-qm", "init");
    git(project, "push", "-q", "-u", "origin", "dev");

    const { exitCode, stdout } = await runHook("2.1.294");

    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });

  test("fails on one stderr line naming the file when the header is not the generated one", async () => {
    landTypes("// hand-written");

    const { exitCode, firstErrorLine } = await runHook("2.1.294");

    expect(exitCode).toBe(1);
    expect(firstErrorLine).toStartWith(`claude-code-types: ${TYPES_PATH}: expected`);
  });
});
