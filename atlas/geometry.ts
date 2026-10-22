export type Point = readonly [number, number];

export type Size = { readonly w: number; readonly h: number };

export type Rect = Size & { readonly x: number; readonly y: number };

export const center = (r: Rect): Point => [r.x + r.w / 2, r.y + r.h / 2];

export const hits = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** A map of the plane that keeps shapes: q = k·p + d, the same scale on both axes. */
export type Similarity = { readonly k: number; readonly dx: number; readonly dy: number };

export const IDENTITY: Similarity = { k: 1, dx: 0, dy: 0 };

export const apply = (s: Similarity, [x, y]: Point): Point => [s.k * x + s.dx, s.k * y + s.dy];

export const applyRect = (s: Similarity, r: Rect): Rect => ({
  x: s.k * r.x + s.dx,
  y: s.k * r.y + s.dy,
  w: s.k * r.w,
  h: s.k * r.h,
});

/** `first`, then `then`. */
export const compose = (first: Similarity, then: Similarity): Similarity => ({
  k: then.k * first.k,
  dx: then.k * first.dx + then.dx,
  dy: then.k * first.dy + then.dy,
});

export const invert = (s: Similarity): Similarity => ({
  k: 1 / s.k,
  dx: -s.dx / s.k,
  dy: -s.dy / s.k,
});

/** The similarity that lands `inner` centred in `outer`, as large as `outer` lets it. */
export function fitting(inner: Rect, outer: Rect): Similarity {
  const k = Math.min(outer.w / inner.w, outer.h / inner.h);
  const [ix, iy] = center(inner);
  const [ox, oy] = center(outer);

  return { k, dx: ox - k * ix, dy: oy - k * iy };
}
