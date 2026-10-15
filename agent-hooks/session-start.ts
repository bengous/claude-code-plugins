import type { HookContext, Verdict } from "./hook.ts";
import { ALLOW } from "./hook.ts";
import { takePhoto } from "./scope.ts";
import { pruneStates } from "./state.ts";

/** Photographs the dirty tree once per (session, root); `resume` and `compact` keep the first photo. */
export function runSessionStart(context: HookContext): Promise<Verdict> {
  if (context.state.photo === null) {
    const photo = takePhoto(context.root);

    if (photo === null) {
      console.error(`agent-hooks: git status failed in ${context.root}, no photo taken`);
    }

    context.state.photo = photo;
  }

  pruneStates();

  return Promise.resolve(ALLOW);
}
