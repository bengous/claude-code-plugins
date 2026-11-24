import { rmSync } from "node:fs";
import path from "node:path";

import { placeOf, staleScratchDirs, takePhoto } from "./checkout.ts";
import { deadlineIn } from "./core/util/exec.ts";
import type { HookOptions, Input, Verdict } from "./hook.ts";
import { ALLOW, DEADLINES_MS, SCRATCH_STALE_MS, raced } from "./hook.ts";
import { messageOf } from "./lib/platform/pure.ts";
import { loadState, persist, pruneStates, stateKey } from "./state.ts";
import { linkDeclaredDirectories } from "./worktree-links.ts";

/**
 * The link step's own budget, taken from the start of the hook: two git calls, a few tens of milliseconds on a normal
 * day. It runs first, so a slow photo can never leave the worktree without its links, and it can delay the photo by
 * this much at most.
 */
const LINK_BUDGET_MS = 1000;

/**
 * In a linked worktree, first links the directories the main checkout declares in `worktree.symlinkDirectories`.
 * Photographs the checkout around the cwd once per agent; `resume` and `compact` keep the first photo. Removes the
 * scratch directories a pre-edit killed while its fixers ran left in the checkout, and the expired states.
 */
export async function runSessionStart(input: Input, options: HookOptions): Promise<Verdict | null> {
  const place = input.cwd === undefined ? null : placeOf(input.cwd);

  if (place === null) {
    return null;
  }

  const state = loadState(stateKey(input.sessionId, input.agentId), place.checkout, options.now);
  const linkNote = linkDeclaredDirectories(place.checkout, deadlineIn(LINK_BUDGET_MS, options.now));

  try {
    await raced("session-start", options, (deadline) => {
      state.photo ??= takePhoto(place.checkout, deadline, options.now);

      for (const dir of staleScratchDirs(place.checkout, SCRATCH_STALE_MS, deadline)) {
        rmSync(path.join(place.checkout, dir), { recursive: true, force: true });
      }

      return Promise.resolve();
    });
  } catch (error) {
    console.error(`agent-hooks: session-start in ${place.checkout}: ${messageOf(error)}`);
  }

  pruneStates(Math.max(...Object.values(DEADLINES_MS)), options.now);
  persist(state, options.now);

  return linkNote === null ? ALLOW : { kind: "note", text: linkNote };
}
