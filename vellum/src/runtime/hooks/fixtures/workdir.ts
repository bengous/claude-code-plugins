import { sessionId, workdirOf } from "../parse.ts";
import { DATE } from "./date.ts";
import { SESSION_ID } from "./session-id.ts";

export const WORKDIR = workdirOf(sessionId(SESSION_ID), DATE);
