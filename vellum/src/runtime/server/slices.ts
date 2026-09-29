import { server as markdownServer } from "../../formats/markdown/server.ts";
import { server as reviewServer } from "../../steps/agent-review/server.ts";
import { server as grillServer } from "../../steps/grill/server.ts";
import { server as stepServer } from "../../steps/proposal/server.ts";
import type { ServerExtension } from "../extension.ts";
import { serverExtension } from "./slice.ts";

export const serverExtensions: readonly ServerExtension[] = [
  serverExtension(markdownServer),
  serverExtension(grillServer),
  serverExtension(stepServer),
  serverExtension(reviewServer),
];
