import type { ServerExtension } from "../core/extension.ts";
import { grillServer } from "./grill/server.ts";
import { markdownServer } from "./markdown/server.ts";
import { reviewServer } from "./review/server.ts";
import { stepServer } from "./step/server.ts";

export const serverExtensions: readonly ServerExtension[] = [
  markdownServer,
  grillServer,
  stepServer,
  reviewServer,
];
