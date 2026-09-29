/**
 * The HTML format: a mockup, served sandboxed in a frame, where the reviewer comments an element
 * and chooses among the options it offers. Besides its page half it has a fourth runtime:
 * `frame.ts` runs inside the mockup, built by its path in `runtime/server/http/serve.ts`, since a
 * slice hands the server no script, and `messages.ts` is what crosses between the frame and the
 * page half. Other folders import this file and nothing else of the folder.
 */
import type { PlugsOf } from "../../workshop/plugs.ts";
import { defineSlice } from "../../workshop/plugs.ts";

export const SLICE = defineSlice({
  id: "html",
  page: ["renderers"],
});

export type HtmlPlugs = PlugsOf<typeof SLICE>;
