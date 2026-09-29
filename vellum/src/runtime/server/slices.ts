import { markdownServer } from "../../formats/markdown/server.ts";
import { reviewServer } from "../../steps/agent-review/server.ts";
import { server as grillServer } from "../../steps/grill/server.ts";
import { server as stepServer } from "../../steps/proposal/server.ts";
import type { ServerExtension } from "../extension.ts";
import { serverExtension } from "./slice.ts";

export const serverExtensions: readonly ServerExtension[] = [
  markdownServer,
  serverExtension(grillServer),
  serverExtension(stepServer),
  reviewServer,
];
