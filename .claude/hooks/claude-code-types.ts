#!/usr/bin/env bun

/**
 * SessionStart hook — shows the last outcome of `scripts/claude-code-types.ts
 * run` once, and starts the run detached when the installed Claude Code is a
 * version no run settled yet and no run is going.
 *
 * The run alone decides, after its fetch, whether a version needs work: the
 * hook reads no ref, only the run's state in `<git common dir>/
 * claude-code-types/`, and never writes into the checkout. Its one output is a
 * `systemMessage`, which the user reads and the model does not. The run sets
 * RUN_GUARD for the sessions it starts, whose SessionStart returns here at
 * once.
 */

import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

import { $ } from "bun";

import {
  commonDirOf,
  installedVersion,
  liveLock,
  type Outcome,
  outcomeLine,
  RUN_GUARD,
  settledVersion,
  type StatePaths,
  statePaths,
} from "../../scripts/claude-code-types.ts";
import { checkoutRoot } from "./checkout.ts";
import { HOOK_EXIT } from "./hook-io.ts";

const SCRIPT = join(import.meta.dir, "../../scripts/claude-code-types.ts");

// A Claude Code session hands its children its identity (CLAUDECODE,
// CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_CHILD_SESSION, its messaging socket) and
// its settings' env. The run's own `claude -p` reads the settings again, so
// none of them goes along, and the run behaves alike started here or by hand.
const SESSION_VARIABLE = /^CLAUDE/u;

const KEPT_VARIABLES: ReadonlySet<string> = new Set(["CLAUDE_CONFIG_DIR"]);

function isErrnoException(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause;
}

/** The outcome, taken by one session alone: renamed first, so a second session finds none. */
function takeOutcome(file: string): Outcome | null {
  const taken = `${file}.${process.pid}`;

  try {
    renameSync(file, taken);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }

  try {
    // SAFETY: only the pipeline writes this file, renamed into place whole, from an Outcome.
    return JSON.parse(readFileSync(taken, "utf8")) as Outcome;
  } finally {
    rmSync(taken, { force: true });
  }
}

function runEnv(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !SESSION_VARIABLE.test(name) || KEPT_VARIABLES.has(name),
      ),
    ),
    [RUN_GUARD]: "1",
  };
}

/** The line about the run going or started now; null when the installed version is settled. */
async function launchLine(root: string, state: StatePaths): Promise<string | null> {
  const holder = liveLock(state.lock);

  if (holder !== null) {
    return `Claude Code types ${holder.version}: a run is going since ${holder.startedAt}, pid ${holder.pid}, log: ${state.log}`;
  }

  const installed = installedVersion(await $`claude --version`.text());

  if (settledVersion(state.settled) === installed) return null;

  // What the run writes before it opens its own log, a crash included.
  mkdirSync(state.dir, { recursive: true });
  const spawnLog = openSync(state.spawnLog, "a");

  try {
    const child = spawn(process.execPath, [SCRIPT, "run"], {
      cwd: root,
      detached: true,
      stdio: ["ignore", spawnLog, spawnLog],
      env: runEnv(),
    });

    child.on("error", (error) => {
      appendFileSync(state.spawnLog, `the run did not start: ${error.message}\n`);
    });
    child.unref();
  } finally {
    closeSync(spawnLog);
  }

  return `Claude Code types ${installed}: checking in the background, log: ${state.log}`;
}

/** The lines for the user; empty when there is nothing to say. */
async function sessionLines(rawInput: string): Promise<string[]> {
  if (process.env[RUN_GUARD] !== undefined) return [];

  // SAFETY: `cwd` is the one field read, and an absent one falls back to
  // the project.
  const { cwd } = JSON.parse(rawInput) as { cwd?: string };
  const root = await checkoutRoot(cwd, process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd());
  const state = statePaths(commonDirOf(root));
  const outcome = takeOutcome(state.outcome);
  const lines = outcome === null ? [] : [outcomeLine(outcome)];

  // The outcome is taken already: a failure past this point is one more line,
  // never the outcome's loss.
  try {
    const launched = await launchLine(root, state);

    return launched === null ? lines : [...lines, launched];
  } catch (error) {
    return [
      ...lines,
      `Claude Code types: the session check failed: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
}

if (import.meta.main) {
  try {
    const lines = await sessionLines(await Bun.stdin.text());

    if (lines.length > 0) console.log(JSON.stringify({ systemMessage: lines.join("\n") }));
  } catch (error) {
    // Claude Code shows the first stderr line of a failed hook, and an
    // uncaught throw makes that line a Bun source frame.
    console.error(`claude-code-types: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(HOOK_EXIT.ERROR);
  }
}
