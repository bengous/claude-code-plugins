import { snapdom } from "@zumer/snapdom";

import type { Box } from "../shared/wire.ts";

/**
 * The zone as the page draws it, a PNG at the screen's pixel ratio. snapdom redraws the DOM rather
 * than reading the screen: no permission to ask, but what the DOM does not hold (a cross-origin
 * iframe, a video frame, WebGL) comes out blank or approximate. `overlay` is left out, so the
 * capture shows the app alone.
 */
export async function captureZone(box: Box, overlay: Element): Promise<Blob> {
  return await snapdom.toBlob(document.documentElement, {
    clip: box,
    exclude: (element) => element === overlay,
    excludeMode: "remove",
    format: "png",
  });
}
