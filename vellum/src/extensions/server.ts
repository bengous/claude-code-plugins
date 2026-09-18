import type { ServerExtension } from "../core/extension.ts";
import { grillServer } from "./grill/server.ts";
import { markdownServer } from "./markdown/server.ts";

export const serverExtensions: readonly ServerExtension[] = [markdownServer, grillServer];
