import { rmSync } from "node:fs";
import path from "node:path";

import type { HookContext } from "../core/runtime/hook.ts";
import { DEADLINES_MS } from "../core/runtime/hook.ts";
import type { Verdict } from "../core/runtime/verdict.ts";
import { ALLOW } from "../core/runtime/verdict.ts";
import { staleScratchDirs, takePhoto } from "../core/session/scope.ts";
import { pruneStates } from "../core/session/state.ts";

/**
 * Photographs the checkout around the cwd once per agent; `resume` and `compact` keep the first photo. Removes the
 * scratch directories a pre-edit killed while its fixers ran left in the checkout.
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

  return Promise.resolve(ALLOW);
}
