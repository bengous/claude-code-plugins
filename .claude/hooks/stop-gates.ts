#!/usr/bin/env bun

/**
 * Stop and SubagentStop hook — runs every CI gate at the end of a turn that
 * edited the repo, and blocks the stop while one is red.
 *
 * `format-on-edit.ts` empties the marker on each in-repo edit. A green run
 * deletes the marker. A red run writes its verdict, the first line of the
 * `scripts/run-gates.ts` report, into the marker and blocks. A later stop with
 * no edit in between ends the turn on the same verdict, with a note to the
 * user: a red the agent cannot fix must not cost every turn Claude Code's 8
 * consecutive blocks.
 *
 * The gates run in the checkout the agent sits in: the git toplevel of the
 * hook's `cwd`, which follows EnterWorktree and a subagent's `isolation:
 * worktree` while `CLAUDE_PROJECT_DIR` stays the launching checkout by design.
 *
 * Skipped in plan mode, where a block loops through ExitPlanMode, and while a
 * subagent, workflow or teammate runs in the background: it may still be
 * editing.
 */

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import { HOOK_EXIT } from "./hook-io.ts";

export interface StopInput {
  session_id?: string;
  agent_id?: string;
  cwd?: string;
  permission_mode?: string;
  background_tasks?: { type?: string }[];
}

const GATES_COMMAND = ["bun", "./scripts/run-gates.ts"];

const EDITING_TASK_TYPES = new Set(["subagent", "workflow", "teammate"]);

export function parseStopInput(raw: string): StopInput | null {
  try {
    // SAFETY: every field of StopInput is optional, so a payload of another
    // shape reads back as absent fields and the stop proceeds.
    return JSON.parse(raw) as StopInput;
  } catch {
    return null;
  }
}

/** Null for an id that is not a single, safe path segment. */
export function markerPath(sessionId: string): string | null {
  return /^[\w-]+$/u.test(sessionId) ? join(tmpdir(), "claude-code-plugins-stop", sessionId) : null;
}

/**
 * The marker of the agent the payload belongs to. A subagent's hook input
 * carries the parent's `session_id` and its own `agent_id`, so keying on
 * `agent_id` first keeps the two markers independent: a green subagent run
 * leaves the parent's mark, and a parent verdict does not release a subagent.
 */
export function markerFor(input: { session_id?: string; agent_id?: string }): string | null {
  const id = input.agent_id ?? input.session_id;

  return id === undefined ? null : markerPath(id);
}

export function skipsGates(input: StopInput): boolean {
  if (input.permission_mode === "plan") return true;

  // `background_tasks` is scoped to the parent session and lists the stopping
  // subagent itself (measured on 2.1.270), so at SubagentStop it names tasks
  // of other checkouts, never editors of this agent's `cwd`.
  if (input.agent_id !== undefined) return false;

  return (input.background_tasks ?? []).some((task) => EDITING_TASK_TYPES.has(task.type ?? ""));
}

/** The repository around `dir`, else the project. */
export async function checkoutRoot(dir: string | undefined, projectDir: string): Promise<string> {
  if (dir === undefined) return projectDir;

  const toplevel = await $`git -C ${dir} rev-parse --show-toplevel`.nothrow().quiet();

  return toplevel.exitCode === 0 ? toplevel.text().trim() : projectDir;
}

if (import.meta.main) {
  const input = parseStopInput(await Bun.stdin.text());
  const marker = input === null ? null : markerFor(input);

  if (input === null || marker === null || skipsGates(input)) process.exit(HOOK_EXIT.ALLOW);

  if (!(await Bun.file(marker).exists())) process.exit(HOOK_EXIT.ALLOW);

  const lastVerdict = await Bun.file(marker).text();
  const projectDir = process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd();

  const gates = await $`${GATES_COMMAND}`
    .cwd(await checkoutRoot(input.cwd, projectDir))
    .nothrow()
    .quiet();

  if (gates.exitCode === 0) {
    await rm(marker, { force: true });
    process.exit(HOOK_EXIT.ALLOW);
  }

  const report = `${gates.stdout.toString()}${gates.stderr.toString()}`.trim();
  const verdict = report.split("\n", 1)[0] ?? "";

  if (verdict === lastVerdict) {
    const note = `${verdict}: unchanged, and nothing edited since the last Stop block.`;
    console.log(JSON.stringify({ systemMessage: note }));
    process.exit(HOOK_EXIT.ALLOW);
  }

  await Bun.write(marker, verdict);
  console.error(`\`${GATES_COMMAND.join(" ")}\` is red; fix it before ending the turn.`);
  console.error(report);
  process.exit(HOOK_EXIT.BLOCK);
}
