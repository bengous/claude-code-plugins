#!/usr/bin/env bun

/**
 * SessionStart hook — starts `scripts/claude-code-types.ts run` detached when
 * the installed Claude Code is newer than the plugin API types `origin/dev`
 * and the rolling branch carry and no run ended for it yet, and shows the
 * last run's outcome once.
 *
 * It reads local refs only, never the network, and never writes into the
 * checkout. Its one output is a `systemMessage`, which the user reads and the
 * model does not. The run sets RUN_GUARD for the sessions it starts, whose
 * SessionStart returns here at once.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { $ } from "bun";

import {
  attemptedVersion,
  BASE,
  commonDirOf,
  installedVersion,
  liveLock,
  needsRun,
  type Outcome,
  outcomeLine,
  refHeader,
  ROLLING_REMOTE,
  RUN_GUARD,
  statePaths,
} from "../../scripts/claude-code-types.ts";
import { checkoutRoot } from "./checkout.ts";
import { HOOK_EXIT } from "./hook-io.ts";

const SCRIPT = join(import.meta.dir, "../../scripts/claude-code-types.ts");

function takeOutcome(file: string): Outcome | null {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  rmSync(file, { force: true });

  // SAFETY: only the pipeline writes this file, from an Outcome.
  return JSON.parse(text) as Outcome;
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
  const devHeader = refHeader(root, BASE);

  if (devHeader === null) return lines;
  const installed = installedVersion(await $`claude --version`.text());

  if (!needsRun({ installed, devHeader, rollingHeader: refHeader(root, ROLLING_REMOTE) })) {
    return lines;
  }

  // A run that ended, failed included, is not started again for the same
  // version: its outcome already told the user how to rerun it by hand.
  if (attemptedVersion(state.attempted) === installed) return lines;

  const holder = liveLock(state.lock);

  if (holder !== null) {
    return [
      ...lines,
      `Claude Code types ${installed}: a run is going since ${holder.startedAt}, pid ${holder.pid}, log: ${state.log}`,
    ];
  }

  spawn(process.execPath, [SCRIPT, "run"], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, [RUN_GUARD]: "1" },
  }).unref();

  return [
    ...lines,
    `Claude Code types ${devHeader} → ${installed}: checking in the background, log: ${state.log}`,
  ];
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
