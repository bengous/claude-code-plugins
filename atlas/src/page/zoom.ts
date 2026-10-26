// A free look inside one view, pure: the camera's rect zoomed around a point or panned, kept
// within the rect that fits the view: never wider than the fit, never narrower than MAX_ZOOM
// allows, never off the drawing. The fit and the rect share the drawing area's aspect. At the
// scale either paints at, a caption too small to read hides (captionShown).
import type { Point, Rect } from "./geometry.ts";

/** The smallest font size, in screen pixels, a caption shows at on its own. */
export const MIN_CAPTION_PX = 10;

/**
 * Whether a caption (an arrow's label, a box's tag, a line of a card's sub-title) shows: `size`, its
 * font size in world units, times `scale`, the screen pixels a world unit spans, reaches
 * MIN_CAPTION_PX; or its arrow is lit by the hovered item, or hot from the selection. A hidden
 * caption keeps its spot.
 */
export const captionShown = (size: number, scale: number, lit: boolean, hot: boolean): boolean =>
  lit || hot || size * scale >= MIN_CAPTION_PX;

/** How far a view can be zoomed into: the fitted rect's width over the narrowest rect allowed. */
export const MAX_ZOOM = 8;

/** The rect kept inside `fit` at `fit`'s aspect, no wider than it, no narrower than MAX_ZOOM allows. */
export function clamped(vb: Rect, fit: Rect): Rect {
  const w = Math.min(fit.w, Math.max(fit.w / MAX_ZOOM, vb.w));
  const h = (w * fit.h) / fit.w;
  const x = Math.min(fit.x + fit.w - w, Math.max(fit.x, vb.x));
  const y = Math.min(fit.y + fit.h - h, Math.max(fit.y, vb.y));

  return { x, y, w, h };
}

/** The rect scaled by `factor` (below 1 zooms in), `at` (in the rect's units) staying put. */
export function zoomed(vb: Rect, at: Point, factor: number, fit: Rect): Rect {
  const [ax, ay] = at;

  return clamped(
    {
      x: ax - (ax - vb.x) * factor,
      y: ay - (ay - vb.y) * factor,
      w: vb.w * factor,
      h: vb.h * factor,
    },
    fit,
  );
}

/** The rect moved so what was under the pointer follows it by (dx, dy), in the rect's units. */
export const panned = (vb: Rect, dx: number, dy: number, fit: Rect): Rect =>
  clamped({ ...vb, x: vb.x - dx, y: vb.y - dy }, fit);

/** Whether the rect shows less than the fit: the reader zoomed in. */
export const zoomedIn = (vb: Rect, fit: Rect): boolean => vb.w < fit.w - 1e-6;
