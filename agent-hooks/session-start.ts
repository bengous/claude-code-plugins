import { rmSync } from "node:fs";
import path from "node:path";

import type { HookContext, Verdict } from "./hook.ts";
import { ALLOW, DEADLINES_MS } from "./hook.ts";
import { staleScratchDirs, takePhoto } from "./scope.ts";
import { pruneStates } from "./state.ts";

/**
 * Photographs the dirty tree once per (session, root); `resume` and `compact` keep the first photo. Removes the
 * scratch directories a pre-edit killed while its fixers ran left in the root.
 */
export function runSessionStart(context: HookContext): Promise<Verdict> {
  if (context.state.photo === null) {
    const photo = takePhoto(context.root);

    if (photo === null) {
      console.error(`agent-hooks: git status failed in ${context.root}, no photo taken`);
    }

    context.state.photo = photo;
  }

  for (const dir of staleScratchDirs(context.root, DEADLINES_MS["pre-edit"])) {
    rmSync(path.join(context.root, dir), { recursive: true, force: true });
  }

  pruneStates(Math.max(...Object.values(DEADLINES_MS)));

  return Promise.resolve(ALLOW);
}
