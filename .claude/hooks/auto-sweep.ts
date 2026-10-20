#!/usr/bin/env bun

/**
 * SessionStart hook — starts git-sweep's `auto-sweep.ts --base dev` detached,
 * at most once a day, from the main checkout only: a session in a linked
 * worktree, an agent's or the types pipeline's, starts none. The day of the
 * last start and the runs' appended output live in `<git common dir>/
 * auto-sweep/`. The run gets no terminal and no prompt, and its failure stays
 * in that log; the hook's one output is a `systemMessage`.
 */

import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { $ } from "bun";

import { checkoutRoot } from "./checkout.ts";
import { HOOK_EXIT } from "./hook-io.ts";

const SCRIPT = join(import.meta.dir, "../../git-sweep/scripts/auto-sweep.ts");

const BASE = "dev";

const NO_PROMPT = {
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS_REQUIRE: "never",
  GH_PROMPT_DISABLED: "1",
};

export type SweepPaths = { dir: string; day: string; log: string };

export function sweepPaths(commonDir: string): SweepPaths {
  const dir = join(commonDir, "auto-sweep");

  return { dir, day: join(dir, "day"), log: join(dir, "sweep.log") };
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** The local calendar day, `YYYY-MM-DD`. */
export function dayOf(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isErrnoException(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause;
}

function lastDay(file: string): string | null {
  try {
    return readFileSync(file, "utf8").trim();
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

/** The common dir when `root` is the main worktree, null in a linked one. */
async function mainCommonDir(root: string): Promise<string | null> {
  const [gitDir, commonDir] = (
    await $`git -C ${root} rev-parse --path-format=absolute --git-dir --git-common-dir`.text()
  )
    .trim()
    .split("\n");

  if (gitDir === undefined || commonDir === undefined) {
    throw new Error(`git rev-parse in ${root} printed no git dir and common dir`);
  }

  return gitDir === commonDir ? commonDir : null;
}

function startSweep(root: string, paths: SweepPaths): void {
  appendFileSync(
    paths.log,
    `--- ${new Date().toISOString()} auto-sweep --base ${BASE}, in ${root}\n`,
  );
  const log = openSync(paths.log, "a");

  try {
    const child = spawn(process.execPath, [SCRIPT, "--base", BASE], {
      cwd: root,
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, ...NO_PROMPT },
    });

    child.on("error", (error) => {
      appendFileSync(paths.log, `auto-sweep did not start: ${error.message}\n`);
    });
    child.unref();
  } finally {
    closeSync(log);
  }
}

/** The line for the user, or null when no sweep starts. */
async function sessionLine(rawInput: string): Promise<string | null> {
  // SAFETY: `cwd` is the one field read, and an absent one falls back to the project.
  const { cwd } = JSON.parse(rawInput) as { cwd?: string };
  const root = await checkoutRoot(cwd, process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd());
  const commonDir = await mainCommonDir(root);

  if (commonDir === null) return null;
  const paths = sweepPaths(commonDir);
  const today = dayOf(new Date());

  if (lastDay(paths.day) === today) return null;

  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.day, today);
  startSweep(root, paths);

  return `auto-sweep: sweeping local branches and agent worktrees against ${BASE} in the background, log: ${paths.log}`;
}

if (import.meta.main) {
  try {
    const line = await sessionLine(await Bun.stdin.text());

    if (line !== null) console.log(JSON.stringify({ systemMessage: line }));
  } catch (error) {
    // Claude Code shows the first stderr line of a failed hook, and an
    // uncaught throw makes that line a Bun source frame.
    console.error(`auto-sweep: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(HOOK_EXIT.ERROR);
  }
}
