#!/usr/bin/env bun

/**
 * SessionStart hook — shows, once, the lines `scripts/renovate-agent.ts run`
 * left for the human, and starts that run detached at most once a day, from
 * the main checkout only, unless a run is going: a session in a linked
 * worktree, the run's own agents' included, starts none. The run's state lives
 * in `<git common dir>/renovate-agent/`; the hook's one output is a
 * `systemMessage`.
 */

import { spawn } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

import { runState, takeFile } from "../../scripts/lib/headless-run.ts";
import { withoutSessionIdentity } from "../../scripts/lib/session-env.ts";
import { type StatePaths, statePaths } from "../../scripts/renovate-agent.ts";
import { checkoutRoot } from "./checkout.ts";
import { HOOK_EXIT } from "./hook-io.ts";
import { claimToday, mainCommonDir } from "./once-a-day.ts";

const SCRIPT = join(import.meta.dir, "../../scripts/renovate-agent.ts");

const NO_PROMPT = {
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS_REQUIRE: "never",
  GH_PROMPT_DISABLED: "1",
};

function takeReport(state: StatePaths): string[] {
  const taken = takeFile(state.report);

  // SAFETY: only the run writes this file, renamed into place whole, from a string array.
  return taken === null ? [] : (JSON.parse(taken) as string[]);
}

function startRun(root: string, state: StatePaths): void {
  mkdirSync(state.dir, { recursive: true });
  // What the run writes before it opens its own log, a crash included.
  const spawnLog = openSync(state.spawnLog, "a");

  try {
    const child = spawn(process.execPath, [SCRIPT, "run"], {
      cwd: root,
      detached: true,
      stdio: ["ignore", spawnLog, spawnLog],
      env: { ...withoutSessionIdentity(process.env), ...NO_PROMPT },
    });

    child.on("error", (error) => {
      appendFileSync(state.spawnLog, `the run did not start: ${error.message}\n`);
    });
    child.unref();
  } finally {
    closeSync(spawnLog);
  }
}

/** The lines for the user; empty when there is nothing to say. */
async function sessionLines(rawInput: string): Promise<string[]> {
  // SAFETY: `cwd` is the one field read, and an absent one falls back to the project.
  const { cwd } = JSON.parse(rawInput) as { cwd?: string };
  const root = await checkoutRoot(cwd, process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd());
  const commonDir = await mainCommonDir(root);

  if (commonDir === null) return [];
  const state = statePaths(commonDir);
  const lines = takeReport(state);

  if (runState(state).kind === "running" || !claimToday(state.day)) return lines;

  startRun(root, state);

  return [
    ...lines,
    `Renovate agent: checking the open Renovate pull requests in the background, log: ${state.runLog}`,
  ];
}

if (import.meta.main) {
  try {
    const lines = await sessionLines(await Bun.stdin.text());

    if (lines.length > 0) console.log(JSON.stringify({ systemMessage: lines.join("\n") }));
  } catch (error) {
    // Claude Code shows the first stderr line of a failed hook, and an
    // uncaught throw makes that line a Bun source frame.
    console.error(`renovate-agent: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(HOOK_EXIT.ERROR);
  }
}
