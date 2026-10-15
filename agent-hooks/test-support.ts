/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- this harness builds hook payloads and reads hook outputs as JSON: a closed type would assert the schema instead of the behaviour, and a wrong shape has to fail an assertion rather than the compiler. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CONFIG_RELATIVE_PATH } from "./config.ts";
import { isRecord } from "./json.ts";

export type TempRepo = {
  readonly dir: string;
  readonly repo: string;
  readonly stateDir: string;
  readonly bin: string;
};

const TEST_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
} as const;

const FIXTURES_DIR = path.join(import.meta.dir, "__fixtures__");

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
 * A git repository under a temporary directory with one commit of `files`, a state dir for AGENT_HOOKS_STATE_DIR
 * and a `bin` dir for fake tools. The repo holds no `.claude/agent-hooks.jsonc` until `writeConfig`.
 */
export function createTempRepo(
  prefix: string,
  files: Readonly<Record<string, string>> = {},
): TempRepo {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const repo = path.join(dir, "repo");
  const stateDir = path.join(dir, "state");
  const bin = path.join(dir, "bin");
  mkdirSync(repo);
  mkdirSync(bin);

  for (const [name, content] of Object.entries(files)) {
    writeRepoFile(repo, name, content);
  }

  git(repo, "init", "-q");

  if (Object.keys(files).length > 0) {
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "initial");
  }

  process.env["AGENT_HOOKS_STATE_DIR"] = stateDir;

  return { dir, repo, stateDir, bin };
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

export function readFixture(harness: "claude" | "codex", name: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(FIXTURES_DIR, harness, `${name}.json`), "utf8"),
  );

  if (!isRecord(parsed)) {
    throw new Error(`fixture ${harness}/${name} is not an object`);
  }

  return parsed;
}

/** The fixture with its session and paths moved into the temp repo. */
export function fixtureIn(
  harness: "claude" | "codex",
  name: string,
  repo: string,
  sessionId = "s1",
): Record<string, unknown> {
  const text = JSON.stringify(readFixture(harness, name))
    .replaceAll("/fixture/user/Work/repo", repo)
    .replaceAll("/fixture/user", path.dirname(repo));

  const parsed: unknown = JSON.parse(text);

  if (!isRecord(parsed)) {
    throw new Error(`fixture ${harness}/${name} is not an object`);
  }

  parsed["session_id"] = sessionId;

  return parsed;
}

export function fixtureNames(harness: "claude" | "codex"): string[] {
  return [...new Bun.Glob("*.json").scanSync(path.join(FIXTURES_DIR, harness))]
    .map((file) => file.slice(0, -".json".length))
    .toSorted();
}
