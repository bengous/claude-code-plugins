/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- this harness builds hook payloads and reads hook outputs as JSON: a closed type would assert the schema instead of the behaviour, and a wrong shape has to fail an assertion rather than the compiler. */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runHook } from "./agent-hooks.ts";
import { CONFIG_RELATIVE_PATH } from "./config.ts";
import { run } from "./core/util/exec.ts";
import { isRecord } from "./core/util/json.ts";
import type { HookKind, HookOptions } from "./hook.ts";
import { parseInput } from "./hook.ts";

export type TempRepo = {
  readonly dir: string;
  readonly repo: string;
  readonly stateDir: string;
};

const TEST_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
} as const;

const FIXTURES_DIR = path.join(import.meta.dir, "__fixtures__", "claude");

/** Removes the GIT_* variables a git hook exports, so a temp repo never reaches the checkout. */
export function scrubGitEnv(): void {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("GIT_")) {
      delete process.env[name];
    }
  }
}

export function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, ...TEST_GIT_IDENTITY },
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }

  return result.stdout.toString();
}

/**
 * A git repository under a temporary directory with one commit of `files`, and a state dir set as
 * AGENT_HOOKS_STATE_DIR. The repo holds no `.claude/agent-hooks.jsonc` until `writeConfig`.
 */
export function createTempRepo(files: Readonly<Record<string, string>> = {}): TempRepo {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "agent-hooks-")));
  const repo = path.join(dir, "repo");
  const stateDir = path.join(dir, "state");
  mkdirSync(repo);
  git(repo, "init", "-q");
  commitFiles(repo, files);
  process.env["AGENT_HOOKS_STATE_DIR"] = stateDir;

  return { dir, repo, stateDir };
}

/** Writes `files` and commits them, so they are the tree's clean baseline. */
export function commitFiles(repo: string, files: Readonly<Record<string, string>>): void {
  for (const [name, content] of Object.entries(files)) {
    writeRepoFile(repo, name, content);
  }

  if (Object.keys(files).length > 0) {
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "files");
  }
}

export function removeTempRepo(temp: TempRepo): void {
  rmSync(temp.dir, { recursive: true, force: true });
}

export function writeRepoFile(repo: string, name: string, content: string): void {
  const target = path.join(repo, name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

export function readRepoFile(repo: string, name: string): string {
  return readFileSync(path.join(repo, name), "utf8");
}

export function writeConfig(repo: string, jsonc: string): void {
  writeRepoFile(repo, CONFIG_RELATIVE_PATH, jsonc);
}

/**
 * A fake tool: a `#!/bin/sh` script named `name` under the repo's `node_modules/.bin`, where the kit resolves
 * commands before PATH. `body` runs with the tool's arguments in `$@`.
 */
export function fakeTool(repo: string, name: string, body: string): string {
  const binDir = path.join(repo, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);

  return file;
}

/** A hook payload or a hook's output line, JSON of Claude Code's open shape. */
export type Json = Record<string, unknown>;

/** A Claude Code payload recorded from a live session, its session and its paths moved into `repo`. */
export function fixtureIn(name: string, repo: string, fields: Readonly<Json> = {}) {
  const text = readFileSync(path.join(FIXTURES_DIR, `${name}.json`), "utf8")
    .replaceAll("/fixture/user/Work/repo", repo)
    .replaceAll("/fixture/user", path.dirname(repo));

  const parsed: unknown = JSON.parse(text);

  if (!isRecord(parsed)) {
    throw new Error(`fixture ${name} is not an object`);
  }

  return { ...parsed, session_id: "s1", ...fields };
}

/** Runs a hook in this process and parses its output line, null when it printed nothing. */
export async function hookOutput(
  hook: HookKind,
  payload: Json,
  options: Partial<HookOptions> = {},
): Promise<Json | null> {
  const input = parseInput(payload);

  if (input === null) {
    throw new Error("the payload has no session_id");
  }

  const output = await runHook(hook, input, { runner: run, now: Date.now(), ...options });

  if (output === null) {
    return null;
  }

  const parsed: unknown = JSON.parse(output);

  if (!isRecord(parsed)) {
    throw new Error(`hook ${hook} printed no object: ${output}`);
  }

  return parsed;
}
