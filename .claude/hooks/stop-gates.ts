#!/usr/bin/env bun

/**
 * Stop and SubagentStop hook — runs every CI gate at the end of a turn that
 * edited the repo, and blocks the stop while one is red.
 *
 * `format-on-edit.ts` marks each checkout of the project's repository an
 * agent edits, the project or one of its worktrees, with an empty verdict.
 * The gates run in each marked checkout. A green run deletes its marker. A
 * red run writes its verdict, the first line of the `scripts/run-gates.ts`
 * report, into the marker and blocks. A later stop with no edit in between
 * ends the turn on the same verdict, with a note to the user: a red the agent
 * cannot fix must not cost every turn Claude Code's 8 consecutive blocks.
 *
 * The marker names the checkout: the hook's `cwd` follows a `cd` into any
 * other repository, and `CLAUDE_PROJECT_DIR` stays the launching checkout by
 * design.
 *
 * Skipped in plan mode, where a block loops through ExitPlanMode, and while a
 * subagent, workflow or teammate runs in the background: it may still be
 * editing.
 */

import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import { HOOK_EXIT } from "./hook-io.ts";

export interface StopInput {
  session_id?: string;
  agent_id?: string;
  permission_mode?: string;
  background_tasks?: { type?: string }[];
}

export interface Marker {
  checkout: string;
  verdict: string;
}

const GATES_COMMAND = ["bun", "./scripts/run-gates.ts"];

const EDITING_TASK_TYPES = new Set(["subagent", "workflow", "teammate"]);

const MARKER_DIR = join(tmpdir(), "claude-code-plugins-stop");

export function parseStopInput(raw: string): StopInput | null {
  try {
    // SAFETY: every field of StopInput is optional, so a payload of another
    // shape reads back as absent fields and the stop proceeds.
    return JSON.parse(raw) as StopInput;
  } catch {
    return null;
  }
}

/**
 * The agent the payload belongs to, or null for an id that is not a single,
 * safe path segment. A subagent's hook input carries the parent's
 * `session_id` and its own `agent_id`, so keying on `agent_id` first keeps
 * the two markers independent: a green subagent run leaves the parent's
 * mark, and a parent verdict does not release a subagent.
 */
export function agentOf(input: { session_id?: string; agent_id?: string }): string | null {
  const id = input.agent_id ?? input.session_id;

  return id !== undefined && /^[\w-]+$/u.test(id) ? id : null;
}

export function markerPath(agent: string, checkout: string): string {
  return join(MARKER_DIR, `${agent}.${Bun.hash(checkout).toString(16)}`);
}

async function writeMarker(path: string, marker: Marker): Promise<void> {
  await Bun.write(path, JSON.stringify(marker));
}

export async function markEdit(
  input: { session_id?: string; agent_id?: string },
  checkout: string,
): Promise<void> {
  const agent = agentOf(input);

  if (agent !== null) await writeMarker(markerPath(agent, checkout), { checkout, verdict: "" });
}

async function markersOf(agent: string): Promise<{ path: string; marker: Marker }[]> {
  const names = await readdir(MARKER_DIR).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];

    throw error;
  });

  const paths = names
    .filter((name) => name.startsWith(`${agent}.`))
    .map((name) => join(MARKER_DIR, name));

  return Promise.all(
    // SAFETY: only markEdit and this hook write these files, both as a Marker.
    paths.map(async (path) => ({ path, marker: (await Bun.file(path).json()) as Marker })),
  );
}

export function skipsGates(input: StopInput): boolean {
  if (input.permission_mode === "plan") return true;

  // `background_tasks` is scoped to the parent session and lists the stopping
  // subagent itself (measured on 2.1.270), so at SubagentStop it names tasks
  // of other checkouts, never editors of this agent's checkout.
  if (input.agent_id !== undefined) return false;

  return (input.background_tasks ?? []).some((task) => EDITING_TASK_TYPES.has(task.type ?? ""));
}

if (import.meta.main) {
  const input = parseStopInput(await Bun.stdin.text());
  const agent = input === null ? null : agentOf(input);

  if (input === null || agent === null || skipsGates(input)) process.exit(HOOK_EXIT.ALLOW);

  const blocks: string[] = [];
  const notes: string[] = [];

  for (const { path, marker } of await markersOf(agent)) {
    const { checkout } = marker;

    if (!existsSync(checkout)) {
      await rm(path, { force: true });
      continue;
    }

    const gates = await $`${GATES_COMMAND}`.cwd(checkout).nothrow().quiet();

    if (gates.exitCode === 0) {
      await rm(path, { force: true });
      continue;
    }

    const report = `${gates.stdout.toString()}${gates.stderr.toString()}`.trim();
    const verdict = report.split("\n", 1)[0] ?? "";

    if (verdict === marker.verdict) {
      notes.push(
        `${verdict} in ${checkout}: unchanged, and nothing edited since the last Stop block.`,
      );
      continue;
    }

    await writeMarker(path, { checkout, verdict });
    blocks.push(
      `\`${GATES_COMMAND.join(" ")}\` is red in ${checkout}; fix it before ending the turn.\n${report}`,
    );
  }

  if (blocks.length > 0) {
    console.error(blocks.join("\n\n"));
    process.exit(HOOK_EXIT.BLOCK);
  }

  if (notes.length > 0) console.log(JSON.stringify({ systemMessage: notes.join("\n") }));
}
