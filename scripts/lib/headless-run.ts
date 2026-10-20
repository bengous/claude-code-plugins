/**
 * The plumbing of a detached run that hands a worktree to a headless Claude:
 * its commands, its lock, its signing probe, its prompt, its log and the
 * notice it leaves the human. `scripts/claude-code-types.ts` and
 * `scripts/renovate-agent.ts` are its runs.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";

import type { Subprocess } from "bun";

import { tryLock, unlock } from "./flock.ts";
import { pluginDirAt, readWorktrees } from "./plugin-sources.ts";

const LOCK_TRIES = 10;

const LOCK_PAUSE_MS = 100;

// git's words when gpg cannot sign ("error: gpg failed to sign the data:");
// probeSigning catches every format before the first commit.
export const SIGNING_FAILED = /gpg failed to sign the data/u;

export const STOP_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];

export interface Result {
  code: number;
  out: string;
  err: string;
}

/** A run's lock and the file naming its holder. */
export interface LockPaths {
  lock: string;
  holder: string;
}

/** A run holds the lock; its holder is null for the instant between its lock and its holder file. */
export type RunState<H> = { kind: "idle" } | { kind: "running"; holder: H | null };

/** The child a run's stop reaches while it runs. */
export interface ChildSlot {
  child: Subprocess | null;
}

/** A command's result; a binary missing from PATH answers 127, as a shell does. */
export function command(args: readonly string[], cwd: string): Result {
  try {
    const result = Bun.spawnSync([...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  } catch (error) {
    return {
      code: 127,
      out: "",
      err: `${args[0]}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function git(cwd: string, ...args: string[]): string {
  const result = command(["git", ...args], cwd);

  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")}: ${`${result.err}${result.out}`.trim()}`);
  }

  return result.out.trimEnd();
}

export function gh(cwd: string, ...args: string[]): string {
  const result = command(["gh", ...args], cwd);

  if (result.code !== 0) throw new Error(`gh ${args.join(" ")}: ${result.err.trim()}`);

  return result.out.trim();
}

export function commonDirOf(cwd: string): string {
  return git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
}

export function lastLine({ out, err }: Result): string {
  return (
    `${out}${err}`
      .trimEnd()
      .split("\n")
      .findLast((line) => line.trim() !== "") ?? ""
  );
}

export async function worktreesOf(cwd: string) {
  const root = pluginDirAt(cwd);

  if (root === null) throw new Error(`${cwd} is no directory`);

  return await readWorktrees(root);
}

/** What a worktree holds that its remote does not: changes, or commits pushed nowhere; null when nothing. */
export function heldWork(path: string): string | null {
  const changes = git(path, "status", "--porcelain");

  if (changes !== "") return `uncommitted changes (${changes.split("\n").length})`;
  const unpushed = git(path, "rev-list", "--count", "HEAD", "--not", "--remotes=origin");

  return unpushed === "0" ? null : `${unpushed} commits pushed nowhere`;
}

/** Writes `content` beside `file`, then renames it into place, so a reader never meets it half-written. */
export function writeWhole(file: string, content: string): void {
  const draft = `${file}.${process.pid}`;
  writeFileSync(draft, content);
  renameSync(draft, file);
}

function isErrnoException(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause;
}

/** The file's content, taken by one reader alone: renamed first, so a second reader finds none. */
export function takeFile(file: string): string | null {
  const taken = `${file}.${process.pid}`;

  try {
    renameSync(file, taken);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }

  try {
    return readFileSync(taken, "utf8");
  } finally {
    rmSync(taken, { force: true });
  }
}

/**
 * Whether a run holds the lock: a shared lock taken for an instant tells,
 * the kernel answering for the holder, alive or not.
 */
export function runState<H>(paths: LockPaths): RunState<H> {
  if (!existsSync(paths.lock)) return { kind: "idle" };
  const fd = openSync(paths.lock, "r");

  try {
    if (tryLock(fd, "shared")) {
      unlock(fd);

      return { kind: "idle" };
    }

    // SAFETY: only takeRunLock writes this file, whole, from an H.
    const holder = existsSync(paths.holder)
      ? (JSON.parse(readFileSync(paths.holder, "utf8")) as H)
      : null;

    return { kind: "running", holder };
  } finally {
    closeSync(fd);
  }
}

/**
 * Takes the run's lock for `holder`: the descriptor the run keeps open until
 * it exits, null while another run holds the lock. The file itself is never
 * removed: a run that opened it before the removal and one that created it
 * after would each hold a lock of their own.
 */
export function takeRunLock<H>(paths: LockPaths, holder: H): number | null {
  const fd = openSync(paths.lock, "a");

  // A session start's check holds the lock shared for an instant.
  for (let tries = 1; !tryLock(fd, "exclusive"); tries++) {
    if (tries === LOCK_TRIES) {
      closeSync(fd);

      return null;
    }

    Bun.sleepSync(LOCK_PAUSE_MS);
  }

  writeWhole(paths.holder, JSON.stringify(holder));

  return fd;
}

/** Fills each `{{name}}` of the template read from `source`; a name without a value is a typo, refused. */
export function promptFor(
  template: string,
  values: Readonly<Record<string, string>>,
  source = "the prompt",
): string {
  return template.replaceAll(/\{\{(\w+)\}\}/gu, (_, name: string) => {
    const value = values[name];

    if (value === undefined) throw new Error(`${source}: no value for {{${name}}}`);

    return value;
  });
}

function spawnProbe(cwd: string, args: readonly string[]): Result {
  const result = Bun.spawnSync([...args], {
    cwd,
    stdin: new TextEncoder().encode("signing probe\n"),
    stdout: "pipe",
    stderr: "pipe",
  });

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

/**
 * Fails fast when commits cannot be signed: a locked key would otherwise fail
 * the run's first commit as a pre-commit refusal, and every commit of the
 * agent after it. The probe signs nothing it keeps, and never asks for a
 * passphrase: a detached run has nobody to type it.
 */
export function probeSigning(cwd: string): void {
  if (command(["git", "config", "--bool", "commit.gpgsign"], cwd).out.trim() !== "true") return;
  const config = (key: string) => command(["git", "config", key], cwd).out.trim();
  const format = config("gpg.format") || "openpgp";

  const probe =
    format === "openpgp"
      ? spawnProbe(cwd, [
          config("gpg.program") || "gpg",
          "--batch",
          "--pinentry-mode",
          "error",
          ...(config("user.signingkey") === "" ? [] : ["--local-user", config("user.signingkey")]),
          "--sign",
          "--output",
          "/dev/null",
        ])
      : command(
          [
            "git",
            "commit-tree",
            "-S",
            "-m",
            "signing probe",
            git(cwd, "hash-object", "-t", "tree", "/dev/null"),
          ],
          cwd,
        );

  if (probe.code !== 0) {
    throw new Error(
      `commits cannot be signed (${lastLine(probe)}): unlock the ${format} key, for instance by signing a commit by hand, and the next session start retries`,
    );
  }
}

/** Runs a command with its output appended to the log; answers its exit code. */
export async function logged(
  args: readonly string[],
  cwd: string,
  run: { log: number; progress: ChildSlot },
  env: Record<string, string> = {},
): Promise<number> {
  const child = Bun.spawn([...args], {
    cwd,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: run.log,
    stderr: run.log,
  });

  run.progress.child = child;

  try {
    return await child.exited;
  } finally {
    run.progress.child = null;
  }
}

/** A desktop notice for the human; a failure to show it goes to the log. */
export function notify(app: string, line: string, critical: boolean, log: number): void {
  const result = command(
    ["notify-send", "-a", app, "-u", critical ? "critical" : "normal", app, line],
    process.cwd(),
  );

  if (result.code !== 0) writeSync(log, `notify-send exited ${result.code}: ${result.err}\n`);
}
