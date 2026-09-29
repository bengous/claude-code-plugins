/**
 * The image format: an image file, fitted to the pane or shown at its real size on a click.
 * Other folders import this file and nothing else of the folder.
 */
import type { PlugsOf } from "../../workshop/plugs.ts";
import { defineSlice } from "../../workshop/plugs.ts";

export const SLICE = defineSlice({
  id: "image",
  page: ["renderers"],
});

export type ImagePlugs = PlugsOf<typeof SLICE>;
