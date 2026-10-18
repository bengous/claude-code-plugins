import { snapdom } from "@zumer/snapdom";

import type { Box } from "../shared/wire.ts";

const CAPTURE_TIMEOUT_MS = 10_000;

/**
 * The zone as the page draws it, a PNG at the screen's pixel ratio. snapdom redraws the DOM rather
 * than reading the screen: no permission to ask, but what the DOM does not hold (a cross-origin
 * iframe, a video frame, WebGL) comes out blank or approximate. `overlay` is hidden, so the
 * capture shows the app alone.
 */
export async function captureZone(box: Box, overlay: Element): Promise<Blob> {
  const capture = snapdom.toBlob(document.documentElement, {
    clip: box,
    exclude: (element) => element === overlay,
    // "remove" shifted the clip sideways on a page at 1280 × 720 (snapdom 3.2.0, Chromium):
    // the overlay stays in the clone, invisible, and the page keeps the layout it had.
    excludeMode: "hide",
    format: "png",
  });

  let timer: ReturnType<typeof setTimeout> | undefined;

  // snapdom waits on the page's fonts and images with no limit of its own; the selection waits on it.
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`the page took more than ${CAPTURE_TIMEOUT_MS / 1000} s to draw the zone`));
    }, CAPTURE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([capture, late]);
  } finally {
    clearTimeout(timer);
  }
}
