import type { EngineExtension } from "../core/engine/extension.ts";
import { grillEngine } from "./grill/engine.ts";

/** Every engine half, in dispatch order; `core/engine/register.ts` alone imports this. */
export const engineExtensions: readonly EngineExtension[] = [grillEngine];
