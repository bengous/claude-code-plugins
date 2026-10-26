// The pure parts of placing a view: the middle items in bands by rank, the side columns or bands
// around them, the chips wrapped in a block, the spot of each arrow's label, and the names of an
// item drawn twice. draw.ts sizes the text and calls ELK and libavoid around them;
// placement.spec.ts runs them.
import type { Direction } from "../model/atlas.ts";
import type { Point, Rect, Size } from "./geometry.ts";
import { hits } from "./geometry.ts";

/**
 * An item that stands on both sides is drawn twice: its arrows leave the "in" copy, named by its
 * id, and arrive at the "out" copy, "<id>~out".
 */
export const OUT = "~out";

export const realId = (id: string): string => (id.endsWith(OUT) ? id.slice(0, -OUT.length) : id);

/** The name of the copy an arrow ends at: the "out" one when `both` and the arrow arrives there. */
export const copyOf = (id: string, both: boolean, arriving: boolean): string =>
  both && arriving ? id + OUT : id;

export type Block = Size & { readonly id: string };

const SIDE_GAP = 44;

/**
 * The blocks of one side in the order they stand, each with where it starts along the side: as
 * near as it can get to the mean centre of the placed boxes it talks to, in that order, never
 * overlapping the one before. A block that talks to none of them goes right after the first of
 * its side-mates it talks to, or last.
 */
function lineUp(
  blocks: readonly Block[],
  partners: (id: string) => readonly string[],
  placed: ReadonlyMap<string, Rect>,
  centre: (r: Rect) => number,
  length: (b: Block) => number,
): Array<readonly [Block, number]> {
  const want = (id: string): number | null => {
    const centres = partners(id).flatMap((o) => {
      const r = placed.get(o);

      return r === undefined ? [] : [centre(r)];
    });

    return centres.length > 0 ? centres.reduce((a, b) => a + b, 0) / centres.length : null;
  };

  const order = blocks
    .filter((b) => want(b.id) !== null)
    .toSorted((a, b) => (want(a.id) ?? 0) - (want(b.id) ?? 0));

  for (const b of blocks.filter((i) => want(i.id) === null)) {
    const mate = partners(b.id).find((p) => order.some((o) => o.id === p));
    const at = mate === undefined ? order.length : order.findIndex((o) => o.id === mate) + 1;
    order.splice(at, 0, b);
  }

  const starts: Array<readonly [Block, number]> = [];
  let end: number | null = null;

  for (const b of order) {
    const wish = want(b.id);
    const next: number | null = end === null ? null : end + SIDE_GAP;

    const start: number =
      wish === null ? (next ?? 0) : Math.max(wish - length(b) / 2, next ?? -Infinity);

    starts.push([b, start]);
    end = start + length(b);
  }

  return starts;
}

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
  const lined = lineUp(
    blocks,
    partners,
    placed,
    (r) => r.y + r.h / 2,
    (b) => b.h,
  );

  return new Map(
    lined.map(([b, y]): [string, Rect] => [
      b.id,
      { x: alignRight ? x - b.w : x, y, w: b.w, h: b.h },
    ]),
  );
}

/**
 * One side band, y fixed: each block as near as it can get to the mean centre of the placed boxes
 * it talks to across, in that order, never overlapping the one on its left; standing on y when
 * `alignBottom`, hanging from it otherwise. A block that talks to none of them goes right after
 * the first of its band-mates it talks to, or last.
 */
export function band(
  blocks: readonly Block[],
  partners: (id: string) => readonly string[],
  placed: ReadonlyMap<string, Rect>,
  y: number,
  alignBottom: boolean,
): Map<string, Rect> {
  const lined = lineUp(
    blocks,
    partners,
    placed,
    (r) => r.x + r.w / 2,
    (b) => b.w,
  );

  return new Map(
    lined.map(([b, x]): [string, Rect] => [
      b.id,
      { x, y: alignBottom ? y - b.h : y, w: b.w, h: b.h },
    ]),
  );
}

/** Placed items and the extent they cover from the origin. */
export type Packed = { readonly rects: ReadonlyMap<string, Rect>; readonly size: Size };

/** A middle item with its box's rank, null when it has none. */
export type Ranked = Block & { readonly rank: number | null };

/**
 * The middle items in bands by rank, one band per rank in rank order and a last one for the items
 * without a rank: under DOWN a row per band, top to bottom, under RIGHT a column per band, left to
 * right. Items stand in data order within their band, `gap` apart, each centred across its band;
 * bands stand `gap` apart, each centred on the longest.
 */
export function banded(blocks: readonly Ranked[], direction: Direction, gap: number): Packed {
  const down = direction === "DOWN";
  const depth = (b: Size): number => (down ? b.h : b.w);
  const breadth = (b: Size): number => (down ? b.w : b.h);
  const keyOf = (b: Ranked): number => b.rank ?? Infinity;
  const keys = [...new Set(blocks.map((b) => keyOf(b)))].toSorted((a, b) => a - b);
  const groups = keys.map((k) => blocks.filter((b) => keyOf(b) === k));

  const lengths = groups.map(
    (g) => g.reduce((sum, b) => sum + breadth(b), 0) + gap * (g.length - 1),
  );

  const span = Math.max(0, ...lengths);
  const rects = new Map<string, Rect>();
  let at = 0;

  for (const [i, group] of groups.entries()) {
    const thick = Math.max(...group.map((b) => depth(b)));
    let across = (span - (lengths[i] ?? 0)) / 2;

    for (const b of group) {
      const along = at + (thick - depth(b)) / 2;
      rects.set(b.id, { x: down ? across : along, y: down ? along : across, w: b.w, h: b.h });
      across += breadth(b) + gap;
    }

    at += thick + gap;
  }

  const extent = groups.length === 0 ? 0 : at - gap;

  return { rects, size: down ? { w: span, h: extent } : { w: extent, h: span } };
}

/**
 * The view's rects: the placed middle moved clear of the "in" side, and both sides placed around
 * it, `gap` from it. Under RIGHT the "in" side is a column on its left and the "out" side one on
 * its right; under DOWN, a band above it and a band below.
 */
export function flank(
  middle: Packed,
  before: readonly Block[],
  after: readonly Block[],
  partners: (id: string) => readonly string[],
  direction: Direction,
  gap: number,
): Map<string, Rect> {
  const down = direction === "DOWN";
  const side = down ? band : column;
  const lead = Math.max(0, ...before.map((b) => (down ? b.h : b.w)));
  const start = lead + gap;

  const rects = new Map(
    [...middle.rects].map(([id, r]): [string, Rect] => [
      id,
      down ? { ...r, y: r.y + start } : { ...r, x: r.x + start },
    ]),
  );

  for (const [id, r] of side(before, partners, rects, lead, true)) {
    rects.set(id, r);
  }

  const end = start + (down ? middle.size.h : middle.size.w) + gap;

  for (const [id, r] of side(after, partners, rects, end, false)) {
    rects.set(id, r);
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
