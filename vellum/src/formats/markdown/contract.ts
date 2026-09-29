/**
 * The Markdown format: a plan, an artifact or a cited file written in Markdown, drawn as a sheet
 * that takes comments; the server reads the plan's links for the documents it names. Other
 * folders import this file and nothing else of the folder.
 */
import type { PlugsOf } from "../../workshop/plugs.ts";
import { defineSlice } from "../../workshop/plugs.ts";

export const SLICE = defineSlice({
  id: "markdown",
  linkedDocs: true,
  page: ["renderers"],
});

export type MarkdownPlugs = PlugsOf<typeof SLICE>;
