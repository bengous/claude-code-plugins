import type { SessionStartInput } from "claude-code";

import { CWD } from "./cwd.ts";

export const SESSION: SessionStartInput = { surface: "terminal", isInteractive: true, cwd: CWD };
