import type { EngineExtension } from "../core/engine/extension.ts";
import { engineExtension } from "../core/engine/slice.ts";
import { hooks as grillHooks } from "./grill/hooks.ts";
import { reviewEngine } from "./review/engine.ts";
import { hooks as stepHooks } from "./step/hooks.ts";

/** Every engine half, in dispatch order; `core/engine/register.ts` alone imports this. */
export const engineExtensions: readonly EngineExtension[] = [
  engineExtension(grillHooks),
  engineExtension(stepHooks),
  reviewEngine,
];
