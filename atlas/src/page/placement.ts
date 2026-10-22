// The pure parts of placing a view: the side columns, the chips wrapped in a block, the spot of
// each arrow's label, and the names of an item drawn twice. draw.ts sizes the text and calls ELK
// and libavoid around them; placement.spec.ts runs them.
import type { Point, Rect, Size } from "./geometry.ts";
import { hits } from "./geometry.ts";

/**
 * An item that stands in both side columns is drawn twice: its arrows leave the left copy, named
 * by its id, and arrive at the right copy, "<id>~out".
 */
export const OUT = "~out";

export const realId = (id: string): string => (id.endsWith(OUT) ? id.slice(0, -OUT.length) : id);

/** The name of the copy an arrow ends at: the right one when `both` and the arrow arrives there. */
export const copyOf = (id: string, both: boolean, arriving: boolean): string =>
  both && arriving ? id + OUT : id;

export type Block = Size & { readonly id: string };

const COLUMN_GAP = 44;

/**
 * One side column, x fixed: each block as near as it can get to the mean centre height of the
 * placed boxes it talks to, in that order, never overlapping the one above. A block that talks to
 * none of them goes right after the first of its column-mates it talks to, or last.
 */
export function column(
  blocks: readonly Block[],
  partners: (id: string) => readonly string[],
  placed: ReadonlyMap<string, Rect>,
  x: number,
  alignRight: boolean,
): Map<string, Rect> {
  const want = (id: string): number | null => {
    const ys = partners(id).flatMap((o) => {
      const r = placed.get(o);

      return r === undefined ? [] : [r.y + r.h / 2];
    });

    return ys.length > 0 ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
  };

  const order = blocks
    .filter((b) => want(b.id) !== null)
    .toSorted((a, b) => (want(a.id) ?? 0) - (want(b.id) ?? 0));

  for (const b of blocks.filter((i) => want(i.id) === null)) {
    const mate = partners(b.id).find((p) => order.some((o) => o.id === p));
    const at = mate === undefined ? order.length : order.findIndex((o) => o.id === mate) + 1;
    order.splice(at, 0, b);
  }

  const rects = new Map<string, Rect>();
  let bottom: number | null = null;

  for (const b of order) {
    const wish = want(b.id);
    const below: number | null = bottom === null ? null : bottom + COLUMN_GAP;

    const y: number = wish === null ? (below ?? 0) : Math.max(wish - b.h / 2, below ?? -Infinity);
    rects.set(b.id, { x: alignRight ? x - b.w : x, y, w: b.w, h: b.h });
    bottom = y + b.h;
  }

  return rects;
}

export type Cell = { readonly x: number; readonly y: number; readonly w: number };

export type Wrapped = { readonly cells: readonly Cell[]; readonly w: number; readonly h: number };

/** Cells of the given widths in rows of at most `target` wide, `gap` apart, every row `rowH` tall. */
export function wrap(
  widths: readonly number[],
  target: number,
  gap: number,
  rowH: number,
): Wrapped {
  const cells: Cell[] = [];
  let x = 0;
  let y = 0;
  let maxX = 0;

  for (const w of widths) {
    if (x > 0 && x + w > target) {
      x = 0;
      y += rowH + gap;
    }

    cells.push({ x, y, w });
    x += w + gap;
    maxX = Math.max(maxX, x - gap);
  }

  return { cells, w: maxX, h: widths.length === 0 ? 0 : y + rowH };
}

const segmentsOf = (pts: readonly Point[]): Array<[Point, Point]> =>
  pts.slice(1).flatMap((q, k): Array<[Point, Point]> => {
    const p = pts[k];

    return p === undefined ? [] : [[p, q]];
  });

const segmentBox = ([p, q]: [Point, Point]): Rect => ({
  x: Math.min(p[0], q[0]) - 1,
  y: Math.min(p[1], q[1]) - 1,
  w: Math.abs(q[0] - p[0]) + 2,
  h: Math.abs(q[1] - p[1]) + 2,
});

const segmentLength = ([p, q]: [Point, Point]): number => Math.hypot(q[0] - p[0], q[1] - p[1]);

const ALONG = [0.5, 0.35, 0.65, 0.2, 0.8];

/**
 * Candidate spots for a label along an arrow, longest segment first: above or below a flat
 * segment, right or left of an upright one, at its middle, then nearer each end.
 */
export function spotsOf(pts: readonly Point[], { w, h }: Size): Rect[] {
  const spots: Rect[] = [];

  for (const [p, q] of segmentsOf(pts).toSorted((s, t) => segmentLength(t) - segmentLength(s))) {
    const flat = Math.abs(q[1] - p[1]) < 1;

    for (const t of ALONG) {
      const cx = p[0] + (q[0] - p[0]) * t;
      const cy = p[1] + (q[1] - p[1]) * t;

      if (flat) {
        spots.push({ x: cx - w / 2, y: cy - h - 3, w, h }, { x: cx - w / 2, y: cy + 3, w, h });
      } else {
        spots.push({ x: cx + 6, y: cy - h / 2, w, h }, { x: cx - w - 6, y: cy - h / 2, w, h });
      }
    }
  }

  return spots;
}

const overlap = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** Where a label landed: its spot, and which of its variants fits there. */
export type Spotted = { readonly spot: Rect; readonly variant: number };

const SLIDE_GAP = 3;

/**
 * A spot that hits obstacles, slid up above the topmost of them and down below the bottommost:
 * a label wider than the gap its arrow crosses floats above or below the items on each side.
 */
function slid(spot: Rect, obstacles: readonly Rect[]): Rect[] {
  const hit = obstacles.filter((o) => hits(spot, o));

  if (hit.length === 0) {
    return [];
  }

  const top = Math.min(...hit.map((o) => o.y));
  const bottom = Math.max(...hit.map((o) => o.y + o.h));

  return [
    { ...spot, y: top - spot.h - SLIDE_GAP },
    { ...spot, y: bottom + SLIDE_GAP },
  ];
}

/**
 * A spot for each label, given the sizes of its variants from the fullest to the shortest. Each
 * variant in turn is tried on the arrow's spots, then on those spots slid clear of the items they
 * hit: first a spot that hits no obstacle, no label placed before it and no other arrow, then one
 * that hits no obstacle and no label; failing every variant, the shortest variant takes the spot
 * that overlaps the obstacles and the placed labels the least. Null for an arrow without a route
 * or without a variant.
 */
export function labelSpots(
  routes: ReadonlyArray<readonly Point[] | null>,
  variants: ReadonlyArray<readonly Size[]>,
  obstacles: readonly Rect[],
): Array<Spotted | null> {
  const segBoxes = routes.map((pts) =>
    pts === null ? [] : segmentsOf(pts).map((s) => segmentBox(s)),
  );

  const taken: Rect[] = [];

  const free = (s: Rect): boolean =>
    !obstacles.some((o) => hits(s, o)) && !taken.some((o) => hits(s, o));

  const crowded = (s: Rect): number =>
    [...obstacles, ...taken].reduce((sum, o) => sum + overlap(s, o), 0);

  return routes.map((pts, i) => {
    const sizes = variants[i] ?? [];
    const shortest = sizes.at(-1);

    if (pts === null || shortest === undefined) {
      return null;
    }

    const others = segBoxes.filter((_, j) => j !== i).flat();

    const clear = sizes.flatMap((size, variant): Spotted[] => {
      const along = spotsOf(pts, size);
      const spots = [...along, ...along.flatMap((s) => slid(s, obstacles))];

      const spot =
        spots.find((s) => free(s) && !others.some((o) => hits(s, o))) ?? spots.find((s) => free(s));

      return spot === undefined ? [] : [{ spot, variant }];
    });

    const [found] = clear;

    const chosen: Spotted =
      found ??
      spotsOf(pts, shortest)
        .map((spot): Spotted => ({ spot, variant: sizes.length - 1 }))
        .reduce((best, next) => (crowded(next.spot) < crowded(best.spot) ? next : best));

    taken.push(chosen.spot);

    return chosen;
  });
}
