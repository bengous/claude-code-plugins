import { reviewEngine } from "../../steps/agent-review/engine.ts";
import { hooks as grillHooks } from "../../steps/grill/hooks.ts";
import { hooks as stepHooks } from "../../steps/proposal/hooks.ts";
import type { EngineExtension } from "./extension.ts";
import { engineExtension } from "./slice.ts";

/** Every engine half, in dispatch order; `runtime/hooks/register.ts` alone imports this. */
export const engineExtensions: readonly EngineExtension[] = [
  engineExtension(grillHooks),
  engineExtension(stepHooks),
  reviewEngine,
];
