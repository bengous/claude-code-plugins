import type { ServerExtension } from "../core/extension.ts";
import { serverExtension } from "../core/server/slice.ts";
import { grillServer } from "./grill/server.ts";
import { markdownServer } from "./markdown/server.ts";
import { reviewServer } from "./review/server.ts";
import { server as stepServer } from "./step/server.ts";

export const serverExtensions: readonly ServerExtension[] = [
  markdownServer,
  grillServer,
  serverExtension(stepServer),
  reviewServer,
];
