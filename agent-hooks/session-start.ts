import { rmSync } from "node:fs";
import path from "node:path";

import { placeOf, staleScratchDirs, takePhoto } from "./checkout.ts";
import type { HookOptions, Input, Verdict } from "./hook.ts";
import { ALLOW, DEADLINES_MS, SCRATCH_STALE_MS, raced } from "./hook.ts";
import { messageOf } from "./lib/platform/pure.ts";
import { loadState, persist, pruneStates, stateKey } from "./state.ts";

/**
 * Photographs the checkout around the cwd once per agent; `resume` and `compact` keep the first photo. Removes the
 * scratch directories a pre-edit killed while its fixers ran left in the checkout, and the expired states.
 */
export async function runSessionStart(input: Input, options: HookOptions): Promise<Verdict | null> {
  const place = input.cwd === undefined ? null : placeOf(input.cwd);

  if (place === null) {
    return null;
  }

  const state = loadState(stateKey(input.sessionId, input.agentId), place.checkout, options.now);

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

  return ALLOW;
}
