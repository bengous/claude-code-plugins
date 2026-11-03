import { rmSync } from "node:fs";
import path from "node:path";

import type { HookContext } from "../core/runtime/hook.ts";
import { DEADLINES_MS, heartbeat } from "../core/runtime/hook.ts";
import { parseInput } from "../core/runtime/payload.ts";
import type { Verdict } from "../core/runtime/verdict.ts";
import { ALLOW } from "../core/runtime/verdict.ts";
import { staleScratchDirs, takePhoto } from "../core/session/scope.ts";
import { endBeats, liveOthers, pruneStates } from "../core/session/state.ts";
import { isRecord } from "../core/util/json.ts";

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
    liveOthers(checkout, context.input.sessionId, Date.now()).length === 0
  ) {
    return ALLOW;
  }

  return {
    kind: "context",
    text: `agent-hooks: another session is live in ${checkout}, and this repository takes one worktree per task: do this task in a worktree of its own (EnterWorktree, or git worktree add), not in this checkout.`,
  };
}

/**
 * UserPromptSubmit, the first hook of every turn: the agent is live again in the checkout around its cwd before any
 * tool runs, whatever its last Stop settled. Prints nothing.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the hook payload arrives as parsed JSON from stdin; this function is where it is narrowed.
export function runUserPromptSubmit(payload: unknown): void {
  const input = isRecord(payload) ? parseInput(payload) : null;

  if (input === null) {
    console.error("agent-hooks: user-prompt-submit payload has no session_id");

    return;
  }

  heartbeat(input);
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
