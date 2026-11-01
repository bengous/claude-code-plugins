// A journey's trace, pure: the curve of each step between the rects of its ends' representatives,
// its head, the point the travelling pill has reached along it, and the camera's frame of a mode.
// engine.ts draws them over the view a step is played in (trace.spec.ts runs them).
import type { Point, Rect, Size } from "./geometry.ts";
import { center } from "./geometry.ts";
import { MAX_ZOOM, clamped } from "./zoom.ts";

/** A quadratic Bézier curve from p0 to p1, its control point c. */
export type Curve = { readonly p0: Point; readonly c: Point; readonly p1: Point };

/**
 * The point of `r`'s border on the way from its centre toward `toward`; its centre when `toward`
 * is that centre.
 */
export function borderToward(r: Rect, toward: Point): Point {
  const [cx, cy] = center(r);
  const dx = toward[0] - cx;
  const dy = toward[1] - cy;

  if (dx === 0 && dy === 0) {
    return [cx, cy];
  }

  const k = Math.min(
    dx === 0 ? Infinity : r.w / 2 / Math.abs(dx),
    dy === 0 ? Infinity : r.h / 2 / Math.abs(dy),
  );

  return [cx + dx * k, cy + dy * k];
}

const BEND = { min: 18, max: 70, share: 0.16, again: 0.8 };

/** How far a step's curve bows out of its chord of length `length`, the `k`-th time its pair is. */
export const bendOf = (length: number, k: number): number =>
  Math.min(BEND.max, Math.max(BEND.min, BEND.share * length)) * (1 + BEND.again * k);

/**
 * A step's curve from `a` to `b`, the rects of its ends' representatives: from the point of a's
 * border toward b's centre to the point of b's border toward a's centre, bowed to the right of its
 * way on screen, so a step and its return part; further for each step before it on the same
 * ordered pair (`k`).
 */
export function curveOf(a: Rect, b: Rect, k: number): Curve {
  const p0 = borderToward(a, center(b));
  const p1 = borderToward(b, center(a));
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const length = Math.hypot(dx, dy);
  const bend = length === 0 ? 0 : bendOf(length, k) / length;
  const m: Point = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];

  return { p0, c: [m[0] - dy * bend, m[1] + dx * bend], p1 };
}

/** The point of a curve at `t`, from 0 (its start) to 1 (its end). */
export function pointAt({ p0, c, p1 }: Curve, t: number): Point {
  const u = 1 - t;

  return [
    u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0],
    u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1],
  ];
}

export const pathOf = ({ p0, c, p1 }: Curve): string =>
  `M${p0[0].toFixed(1)} ${p0[1].toFixed(1)} Q${c[0].toFixed(1)} ${c[1].toFixed(1)} ${p1[0].toFixed(1)} ${p1[1].toFixed(1)}`;

/**
 * For each of a section's traced steps, in order, by the ordered pair of its representatives
 * (`pairs`): how many steps before it have that same pair.
 */
export function repeatsOf(pairs: readonly string[]): number[] {
  const seen = new Map<string, number>();

  return pairs.map((pair) => {
    const k = seen.get(pair) ?? 0;
    seen.set(pair, k + 1);

    return k;
  });
}

/**
 * The copies of an item a view draws: the one its arrows leave (`in`) and the one they reach
 * (`out`), the same rect for an item drawn once.
 */
export type Copies = { readonly in: Rect; readonly out: Rect };

/** A step a view traces: what stands for its ends there, and whether it goes back. */
export type Way = { readonly from: string; readonly to: string; readonly back: boolean };

/** A step's trace: the rects it joins, from `a` to `b`, and its curve. */
export type Course = { readonly a: Rect; readonly b: Rect; readonly curve: Curve };

/**
 * The trace of each of a section's traced steps, in order, from the copies of what stands for its
 * ends (`copiesOf`, undefined for none): a step forward leaves the `in` copy of an item drawn
 * twice and reaches its `out` copy, as the view's arrows do (`Side`, atlas.ts), a step back the
 * reverse; each bowed further for each step before it on the same ordered pair (repeatsOf). Null
 * for a step an end of which has no copy.
 */
export function coursesOf(
  ways: readonly Way[],
  copiesOf: (id: string) => Copies | undefined,
): (Course | null)[] {
  const repeats = repeatsOf(ways.map(({ from, to }) => JSON.stringify([from, to])));

  return ways.map((way, i) => {
    const from = copiesOf(way.from);
    const to = copiesOf(way.to);

    if (from === undefined || to === undefined) {
      return null;
    }

    const [a, b] = way.back ? [from.out, to.in] : [from.in, to.out];

    return { a, b, curve: curveOf(a, b, repeats[i] ?? 0) };
  });
}

/** A curve's head: its end, and the angle, in degrees, of its way into it. */
export type Head = { readonly at: Point; readonly angle: number };

export function headOf({ p0, c, p1 }: Curve): Head {
  const [fx, fy] = c[0] === p1[0] && c[1] === p1[1] ? p0 : c;

  return { at: p1, angle: (Math.atan2(p1[1] - fy, p1[0] - fx) * 180) / Math.PI };
}

const PIECES = 24;

/** A curve's length, in its view's units, measured along PIECES chords. */
export function lengthOf(curve: Curve): number {
  let length = 0;
  let [x, y] = curve.p0;

  for (let i = 1; i <= PIECES; i += 1) {
    const [nx, ny] = pointAt(curve, i / PIECES);
    length += Math.hypot(nx - x, ny - y);
    [x, y] = [nx, ny];
  }

  return length;
}

/**
 * The length on screen, in pixels, of a step's head: `atFit`, the length it has at the view's fit,
 * whatever the zoom, but never longer than its curve on screen, `length` units at `pxPerUnit`.
 */
export const headPx = (atFit: number, length: number, pxPerUnit: number): number =>
  Math.min(atFit, length * pxPerUnit);

/** The travelling pill: it waits `delay` ms after its step shows, then travels for `ms` ms. */
export const TRAVEL = { delay: 250, ms: 1000 };

const easeInOut = (p: number): number => (p < 0.5 ? 2 * p * p : 1 - (2 - 2 * p) ** 2 / 2);

/**
 * How far along its step's curve the travelling pill is, `elapsed` ms after the step shows: at its
 * start until TRAVEL.delay, then speeding up and slowing down to its end, where it stays.
 */
export function travelled(elapsed: number): number {
  const p = (elapsed - TRAVEL.delay) / TRAVEL.ms;

  return easeInOut(Math.min(1, Math.max(0, p)));
}

/**
 * The form the travelling pill carries at `t` along its step: during the first half, the form
 * the data had before the step (formBefore), none when it had none yet or the step opens its
 * section, the dot then travelling alone; from mid-way, the form after the step.
 */
export const formAt = (before: string | null, after: string | null, t: number): string | null =>
  t < 0.5 ? before : after;

/**
 * A mark drawn at a constant size on screen, anchored at `at` in the view's units: `box`, in
 * screen pixels, around the anchor.
 */
export type Pinned = { readonly at: Point; readonly box: Rect };

const bounds = (rects: readonly Rect[]): Rect => {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));

  return {
    x,
    y,
    w: Math.max(...rects.map((r) => r.x + r.w)) - x,
    h: Math.max(...rects.map((r) => r.y + r.h)) - y,
  };
};

const unitsOf = ({ at, box }: Pinned, perPx: number): Rect => ({
  x: at[0] + box.x * perPx,
  y: at[1] + box.y * perPx,
  w: box.w * perPx,
  h: box.h * perPx,
});

// The marks' size in the view's units hangs on the scale the frame gives: a few passes settle it,
// what the last one leaves over falling within the margin.
const PASSES = 3;

/**
 * The camera's frame of `rects` (in the view's units) and of `pinned` marks: the rect at the
 * drawing area's aspect, `screen` in pixels, whose part above the ribbon (its `share` of the
 * height) holds them all, centred, with `margin` pixels around; never closer than MAX_ZOOM allows,
 * and kept within `fit`, the rect that fits the view above the ribbon (clamped).
 */
export function frameOf(
  rects: readonly Rect[],
  pinned: readonly Pinned[],
  screen: Size,
  share: number,
  margin: number,
  fit: Rect,
): Rect {
  if (rects.length === 0 && pinned.length === 0) {
    return fit;
  }

  const wide = Math.max(1, screen.w - 2 * margin);
  const high = Math.max(1, screen.h * share - 2 * margin);

  const boundsAt = (unitsPerPx: number): Rect =>
    bounds([...rects, ...pinned.map((p) => unitsOf(p, unitsPerPx))]);

  const pxPerUnitOf = (r: Rect): number => Math.min(wide / r.w, high / r.h);
  let all = boundsAt(0);

  for (let pass = 1; pass < PASSES; pass += 1) {
    all = boundsAt(1 / pxPerUnitOf(all));
  }

  const w = Math.min(fit.w, Math.max(fit.w / MAX_ZOOM, screen.w / pxPerUnitOf(all)));
  const h = (w * fit.h) / fit.w;
  const [cx, cy] = center(all);

  return clamped({ x: cx - w / 2, y: cy - (h * share) / 2, w, h }, fit);
}
