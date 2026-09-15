import type { ServerPlugin } from "../src/protocol.ts";
import { markdownServer } from "./markdown/server.ts";

export const serverPlugins: readonly ServerPlugin[] = [markdownServer];
