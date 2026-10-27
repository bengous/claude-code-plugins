import { rmSync } from "node:fs";
import path from "node:path";

import type { HookContext } from "./hook.ts";
import { DEADLINES_MS, parseInput } from "./hook.ts";
import { isRecord } from "./json.ts";
import { staleScratchDirs, takePhoto } from "./scope.ts";
import { endBeats, liveOthers, pruneStates } from "./state.ts";
import type { Verdict } from "./verdict.ts";
import { ALLOW } from "./verdict.ts";

/**
 * How recently another session must have run a kit hook in the checkout to count as working there. Every kit hook
 * beats: in the local transcripts, 99.2% of the gaps between two hook runs of one session or subagent ran under 15
 * minutes (67,849 gaps over 1,185 transcripts in roots holding the config, the 30 days to 2026-10-17; p95 2.1 min,
 * p99 11.9 min). A session that ends removes its beats at SessionEnd.
 */
export const LIVE_SESSION_MS = 15 * 60 * 1000;

/** The sources of a session that starts its work: never one resumed, compacted or forked mid-task. */
const STARTING_SOURCES = new Set(["startup", "clear"]);

/**
 * Photographs the checkout around the cwd once per agent; `resume` and `compact` keep the first photo. Removes the
 * scratch directories a pre-edit killed while its fixers ran left in the checkout. Under `profile.worktree:
 * "per-task"`, tells a session that starts to take a worktree of its own when another one works in this checkout.
 */
export function runSessionStart(context: HookContext): Promise<Verdict> {
  const { state } = context;

  if (state.photo === null) {
    const photo = takePhoto(state.checkout);

    if (photo === null) {
      console.error(`agent-hooks: git status failed in ${state.checkout}, no photo taken`);
    }

    state.photo = photo;
  }

  for (const dir of staleScratchDirs(state.checkout, DEADLINES_MS["pre-edit"])) {
    rmSync(path.join(state.checkout, dir), { recursive: true, force: true });
  }

  pruneStates(Math.max(...Object.values(DEADLINES_MS)));

  return Promise.resolve(worktreeNote(context));
}

function worktreeNote(context: HookContext): Verdict {
  const { checkout } = context.state;

  if (
    context.config.profile.worktree !== "per-task" ||
    !STARTING_SOURCES.has(context.input.source ?? "") ||
    liveOthers(checkout, context.input.sessionId, Date.now() - LIVE_SESSION_MS).length === 0
  ) {
    return ALLOW;
  }

  return {
    kind: "context",
    text: `agent-hooks: another session ran a hook in ${checkout} in the last ${LIVE_SESSION_MS / 60_000} minutes, and this repository takes one worktree per task: do this task in a worktree of its own (EnterWorktree, or git worktree add), not in this checkout.`,
  };
}

/** SessionEnd, `/clear` included: the session and its subagents are no longer live anywhere. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the hook payload arrives as parsed JSON from stdin; this function is where it is narrowed.
export function runSessionEnd(payload: unknown): void {
  const input = isRecord(payload) ? parseInput(payload) : null;

  if (input === null) {
    console.error("agent-hooks: session-end payload has no session_id");

    return;
  }

  endBeats(input.sessionId);
}
