import { snapdom } from "@zumer/snapdom";

import type { Box } from "../shared/wire.ts";

/**
 * The zone as the page draws it, a PNG at the screen's pixel ratio. snapdom redraws the DOM rather
 * than reading the screen: no permission to ask, but what the DOM does not hold (a cross-origin
 * iframe, a video frame, WebGL) comes out blank or approximate. `overlay` is hidden, so the
 * capture shows the app alone. snapdom waits on the page's fonts and images with no limit of its
 * own; the send that needs the image bounds its wait.
 */
export function captureZone(box: Box, overlay: Element): Promise<Blob> {
  return snapdom.toBlob(document.documentElement, {
    clip: box,
    // A selector, not a predicate: snapdom reuses its clone of the page across captures only
    // when no exclusion runs code (its `exclude` doc).
    exclude: overlay.localName,
    // "remove" shifted the clip sideways on a Slidev page at 1280 × 720 (snapdom 3.2.0, Chromium):
    // the overlay stays in the clone, invisible, and the page keeps the layout it had.
    excludeMode: "hide",
    format: "png",
  });
}
