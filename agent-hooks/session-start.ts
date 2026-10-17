import { rmSync } from "node:fs";
import path from "node:path";

import type { HookContext, Verdict } from "./hook.ts";
import { ALLOW, DEADLINES_MS } from "./hook.ts";
import { staleScratchDirs, takePhoto } from "./scope.ts";
import { othersInCheckout, pruneStates } from "./state.ts";

/**
 * How recently another session must have saved its state of the checkout to count as working there. A live session
 * saves it at each Stop: in the local transcripts, 88% of the gaps between two Stops of one session ran under 30
 * minutes (145 gaps, 25 sessions in roots holding the config, the 7 days to 2026-10-17); past it, mostly sessions
 * left idle or ended.
 */
export const LIVE_SESSION_MS = 30 * 60 * 1000;

/**
 * Photographs the checkout around the cwd once per agent; `resume` and `compact` keep the first photo. Removes the
 * scratch directories a pre-edit killed while its fixers ran left in the checkout. Under `profile.worktree:
 * "per-task"`, tells the agent to take a worktree of its own when another session works in this checkout.
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
    othersInCheckout(checkout, context.input.sessionId, Date.now() - LIVE_SESSION_MS).length === 0
  ) {
    return ALLOW;
  }

  return {
    kind: "context",
    text: `agent-hooks: another session worked in ${checkout} in the last ${LIVE_SESSION_MS / 60_000} minutes, and this repository takes one worktree per task: do this task in a worktree of its own (EnterWorktree, or git worktree add), not in this checkout.`,
  };
}
