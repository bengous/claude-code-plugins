import { sessionId, workdirOf } from "../parse.ts";
import { DATE } from "./date.ts";
import { OTHER_ID } from "./other-id.ts";

export const OTHER_WORKDIR = workdirOf(sessionId(OTHER_ID), DATE);
