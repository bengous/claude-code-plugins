// The renderer of one view (view.ts), on a layer of its own, at its own origin:
// 1. Items: a container child as a box listing its own children as chips, a leaf child as a card
//    with its subtitle, a ghost as a pill. An outside child of the root stands in the column of its
//    side, a ghost in the column its arrows give it; one in both columns is drawn twice
//    (placement.ts), its arrows leaving the left copy and arriving at the right one.
// 2. Placement. A view with a container child is packed: ELK's rectpacking packs the middle items
//    in data order (it keeps the order it is given, so reordering a node's children moves its
//    boxes), aiming at the aspect of the screen less the room of the two side columns when the
//    Config's overview ratio is "screen", or at the ratio it gives; libavoid routes one arrow per
//    pair around every item. A view of leaves alone is layered: ELK's layered layout places the
//    cards and the pills left to right and routes the arrows with their labels and tags.
// 3. Labels of a packed view take the longest segment of their arrow where the label hits no item,
//    no other label and no other arrow; failing that, one that hits no item and no label; failing
//    that, the longest segment. On libavoid's failure (libavoid.wasm unreachable) the view is drawn
//    without arrows and the panel says why: never block the page.
import type { ElkNode } from "elkjs/lib/elk.bundled.js";
import ELK from "elkjs/lib/elk.bundled.js";

import type { Pins, Side } from "./atlas.ts";
import { routeLinks } from "./avoid.ts";
import type { Point, Rect, Size } from "./geometry.ts";
import type { LayoutEdge } from "./layout.ts";
import { ROOT_COORDS, elkLayered } from "./layout.ts";
import {
  BOX,
  CARD,
  CHIP,
  GHOST,
  cardSize,
  labelSize,
  subLines,
  tagOf,
  textWidth,
  titleWidth,
} from "./measure.ts";
import type { PlaceEvent } from "./navigation.ts";
import type { Block, Cell } from "./placement.ts";
import { OUT, column, copyOf, labelSpots, realId, wrap } from "./placement.ts";
import { paletteVar } from "./settings.ts";
import { arrowPath, el, onActivate, openBadge, rounded, text } from "./svg.ts";
import type { Arrow, Chip, ContainerBox, Ghost, LeafBox, View } from "./view.ts";
import type { Words } from "./words.ts";

export type Mode = "packed" | "layered";

export type Pick = (ev: PlaceEvent) => void;

/**
 * "screen": aspect is the width / height of the drawing area, and the middle items aim at the
 * aspect that, with the side columns added, matches it. "fixed": the middle items' own aspect.
 */
export type Packing =
  | { readonly kind: "screen"; readonly aspect: number }
  | { readonly kind: "fixed"; readonly ratio: number };

/** What render() toggles: the drawn groups of each node, by its id. */
export type Registry = Map<string, SVGGElement[]>;

export type ArrowEl = {
  readonly arrow: Arrow;
  readonly g: SVGGElement;
  readonly path: SVGPathElement;
  readonly marker: string;
};

export type Drawn = {
  readonly view: View;
  readonly mode: Mode;
  readonly layer: SVGGElement;
  /** The whole drawing, from the origin. */
  readonly size: Size;
  /** Where the view's boxes stand: what the camera aligns with the box of this view's container. */
  readonly frame: Rect;
  /** Each box's rect, by its id. */
  readonly rects: ReadonlyMap<string, Rect>;
  readonly items: Registry;
  readonly arrows: readonly ArrowEl[];
  readonly avoidError: string | null;
};

type Column = Exclude<Side, "both"> | null;

type Figure =
  | { readonly kind: "box"; readonly box: ContainerBox; readonly cells: readonly Cell[] }
  | { readonly kind: "card"; readonly box: LeafBox }
  | { readonly kind: "ghost"; readonly ghost: Ghost };

type Item = Block & { readonly figure: Figure; readonly column: Column };

type End = { readonly from: string; readonly to: string };

const MARGIN = 40;

const COL_GAP = 150;

const PACK_GAP = 56;

// The packing's aspect stays between these bounds whatever the screen.
const RATIO = { min: 0.6, max: 4, passes: 3, settled: 0.05 };

const clampRatio = (r: number): number => Math.min(RATIO.max, Math.max(RATIO.min, r));

function boxItem(box: ContainerBox): Omit<Item, "column"> {
  const widths = box.chips.map((c) => Math.ceil(textWidth(c.label, CHIP.cls)) + 2 * CHIP.pad);
  const total = widths.reduce((a, w) => a + w + CHIP.gap, 0);
  const headW = titleWidth(box.label, box.sub);
  // Chips wrap at a width that makes the block about 2.6 times wider than tall.
  const target = Math.max(headW, Math.min(CHIP.maxW, Math.sqrt(total * (CHIP.h + CHIP.gap) * 2.6)));
  const wrapped = wrap(widths, target, CHIP.gap, CHIP.h);

  return {
    id: box.id,
    w: Math.ceil(Math.max(wrapped.w, headW) + 2 * BOX.padX),
    h: BOX.top + wrapped.h + BOX.bottom,
    figure: { kind: "box", box, cells: wrapped.cells },
  };
}

const cardItem = (box: LeafBox): Omit<Item, "column"> => ({
  id: box.id,
  ...cardSize(box.label, box.sub),
  figure: { kind: "card", box },
});

const ghostItem = (ghost: Ghost): Omit<Item, "column"> => ({
  id: ghost.id,
  w: Math.ceil(textWidth(ghost.label, GHOST.cls)) + 2 * GHOST.pad,
  h: GHOST.h,
  figure: { kind: "ghost", ghost },
});

function itemsOf(view: View): Item[] {
  const items: Item[] = [];

  const add = (item: Omit<Item, "column">, side: Side | null): void => {
    if (side === "both") {
      items.push({ ...item, column: "in" }, { ...item, id: item.id + OUT, column: "out" });
    } else {
      items.push({ ...item, column: side });
    }
  };

  for (const box of view.boxes) {
    add(box.kind === "container" ? boxItem(box) : cardItem(box), box.column);
  }

  for (const ghost of view.ghosts) {
    add(ghostItem(ghost), ghost.side);
  }

  return items;
}

/** The copies the arrows join: an item drawn twice is left by its left copy, reached at its right. */
function endsOf(view: View, items: readonly Item[]): End[] {
  const twice = new Set(items.flatMap((i) => (i.id.endsWith(OUT) ? [realId(i.id)] : [])));

  return view.arrows.map((a) => ({
    from: copyOf(a.from, twice.has(a.from), false),
    to: copyOf(a.to, twice.has(a.to), true),
  }));
}

type Placed = {
  readonly rects: ReadonlyMap<string, Rect>;
  readonly size: Size;
  readonly frame: Rect;
  /** How far the layout's own coordinates moved to land the drawing at its margin. */
  readonly shift: Point;
};

const bounds = (rects: readonly Rect[]): Rect => {
  if (rects.length === 0) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }

  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));

  return {
    x,
    y,
    w: Math.max(...rects.map((r) => r.x + r.w)) - x,
    h: Math.max(...rects.map((r) => r.y + r.h)) - y,
  };
};

// Every rect moved so the drawing starts at MARGIN on both axes, with MARGIN after it.
function framed(rects: ReadonlyMap<string, Rect>, boxes: readonly string[]): Placed {
  const all = bounds([...rects.values()]);
  const dx = MARGIN - all.x;
  const dy = MARGIN - all.y;

  const shifted = new Map(
    [...rects].map(([id, r]): [string, Rect] => [id, { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h }]),
  );

  const own = boxes.flatMap((id) => {
    const r = shifted.get(id);

    return r === undefined ? [] : [r];
  });

  return {
    rects: shifted,
    size: { w: all.w + 2 * MARGIN, h: all.h + 2 * MARGIN },
    frame: bounds(own.length === 0 ? [...shifted.values()] : own),
    shift: [dx, dy],
  };
}

type Packed = { readonly rects: ReadonlyMap<string, Rect>; readonly size: Size };

async function pack(middle: readonly Item[], ratio: number): Promise<Packed> {
  if (middle.length === 0) {
    return { rects: new Map(), size: { w: 0, h: 0 } };
  }

  const root: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "rectpacking",
      "elk.aspectRatio": ratio.toFixed(2),
      "elk.padding": "[top=0,left=0,bottom=0,right=0]",
      "elk.spacing.nodeNode": String(PACK_GAP),
      ...ROOT_COORDS,
    },
    children: middle.map((i) => ({ id: i.id, width: i.w, height: i.h })),
  };

  const laid = await new ELK().layout(root);

  const rects = new Map(
    (laid.children ?? []).map((c): [string, Rect] => [
      c.id,
      { x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0 },
    ]),
  );

  return { rects, size: { w: laid.width ?? 0, h: laid.height ?? 0 } };
}

async function placePacked(
  items: readonly Item[],
  ends: readonly End[],
  packing: Packing,
): Promise<Placed> {
  const middle = items.filter((i) => i.column === null);
  const left = items.filter((i) => i.column === "in");
  const right = items.filter((i) => i.column === "out");
  const leftW = Math.max(0, ...left.map((i) => i.w));
  const rightW = Math.max(0, ...right.map((i) => i.w));
  const sidesW = leftW + rightW + 2 * COL_GAP + 2 * MARGIN;
  let ratio = packing.kind === "screen" ? clampRatio(packing.aspect) : packing.ratio;
  let packed = await pack(middle, ratio);

  if (packing.kind === "screen") {
    for (let pass = 1; pass < RATIO.passes; pass++) {
      const next = clampRatio(packing.aspect - sidesW / Math.max(1, packed.size.h));

      if (Math.abs(next - ratio) < RATIO.settled) {
        break;
      }

      ratio = next;
      packed = await pack(middle, ratio);
    }
  }

  const sx = leftW + COL_GAP;

  const rects = new Map(
    [...packed.rects].map(([id, r]): [string, Rect] => [id, { ...r, x: r.x + sx }]),
  );

  const partners = (id: string): string[] =>
    ends.flatMap((e) => (e.from === id ? [e.to] : e.to === id ? [e.from] : []));

  for (const [id, r] of column(left, partners, rects, leftW, true)) {
    rects.set(id, r);
  }

  for (const [id, r] of column(right, partners, rects, sx + packed.size.w + COL_GAP, false)) {
    rects.set(id, r);
  }

  return framed(
    rects,
    middle.map((i) => i.id),
  );
}

type Laid = Placed & {
  readonly routes: ReadonlyArray<readonly Point[] | null>;
  readonly labels: ReadonlyArray<Rect | null>;
  readonly avoidError: string | null;
};

const arrowText = (a: Arrow, mode: Mode): string =>
  mode === "layered" && a.tags.length > 0 ? `${a.label} · ${a.tags.join(", ")}` : a.label;

// An arrow into an item of the left column, or out of one of the right column, is laid out
// reversed: ELK's layers run left to right, so a pure sink would otherwise land on the right.
async function layeredView(
  view: View,
  items: readonly Item[],
  ends: readonly End[],
): Promise<Laid> {
  const columnOf = new Map(items.map((i) => [i.id, i.column]));

  const edges = view.arrows.map((a, i): LayoutEdge => ({
    from: ends[i]?.from ?? a.from,
    to: ends[i]?.to ?? a.to,
    label: arrowText(a, "layered"),
    flip:
      columnOf.get(ends[i]?.to ?? a.to) === "in" || columnOf.get(ends[i]?.from ?? a.from) === "out",
  }));

  const laid = await elkLayered(items, edges, labelSize);

  const placed = framed(
    laid.boxes,
    items.flatMap((i) => (i.figure.kind === "ghost" ? [] : [i.id])),
  );

  const [dx, dy] = placed.shift;
  const shift = (r: Rect): Rect => ({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });

  return {
    ...placed,
    routes: laid.paths.map((p) => p.pts.map(([x, y]): Point => [x + dx, y + dy])),
    labels: laid.paths.map((p) => (p.label === null ? null : shift(p.label))),
    avoidError: null,
  };
}

async function packedView(
  view: View,
  items: readonly Item[],
  ends: readonly End[],
  packing: Packing,
  pins: Pins,
): Promise<Laid> {
  const placed = await placePacked(items, ends, packing);
  const obstacles = [...placed.rects.values()];

  try {
    const routes = await routeLinks(placed.rects, [], ends, pins);

    const sizes = view.arrows.map((a) =>
      a.label === "" ? null : labelSize(arrowText(a, "packed")),
    );

    return { ...placed, routes, labels: labelSpots(routes, sizes, obstacles), avoidError: null };
  } catch (error: unknown) {
    return {
      ...placed,
      routes: view.arrows.map(() => null),
      labels: view.arrows.map(() => null),
      avoidError: error instanceof Error ? error.message : String(error),
    };
  }
}

const colorStyle = (color: string): string => `--zc: var(${paletteVar(color)})`;

function register(items: Registry, id: string, g: SVGGElement): void {
  const list = items.get(id) ?? [];
  list.push(g);
  items.set(id, list);
}

function drawChip(
  layer: SVGGElement,
  chip: Chip,
  cell: Cell,
  r: Rect,
  items: Registry,
  pick: Pick,
): void {
  const g = el(
    "g",
    {
      class: `chip${chip.off ? " off" : ""}`,
      style: colorStyle(chip.color),
      "data-id": chip.id,
    },
    layer,
  );

  const x = r.x + BOX.padX + cell.x;
  const y = r.y + BOX.top + cell.y;
  el("rect", { x, y, width: cell.w, height: CHIP.h, rx: 5 }, g);
  text(g, { x: x + cell.w / 2, y: y + 23, class: CHIP.cls, "text-anchor": "middle" }, chip.label);
  openBadge(g, chip.open, x + cell.w - 2, y + 2, true);
  onActivate(g, chip.label, () => {
    pick({ type: "jump", id: chip.id });
  });

  register(items, chip.id, g);
}

function drawBox(
  frames: SVGGElement,
  top: SVGGElement,
  box: ContainerBox,
  cells: readonly Cell[],
  r: Rect,
  items: Registry,
  words: Words,
  pick: Pick,
): void {
  const g = el("g", { class: "box", style: colorStyle(box.color), "data-id": box.id }, frames);
  el("rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: 10, class: "box-bg" }, g);
  text(g, { x: r.x + 16, y: r.y + 31, class: BOX.title }, box.label);
  text(g, { x: r.x + 16, y: r.y + 48, class: BOX.tag }, tagOf(box.sub));
  openBadge(g, box.open, r.x + r.w - 16, r.y + 16, false);
  onActivate(g, words.zoneLabel(box.label), () => {
    pick({ type: "enter", id: box.id });
  });

  register(items, box.id, g);

  for (const [i, chip] of box.chips.entries()) {
    const cell = cells[i];

    if (cell === undefined) {
      throw new Error(`box ${box.id}: no cell for chip ${chip.id}`);
    }

    drawChip(top, chip, cell, r, items, pick);
  }
}

function drawCard(layer: SVGGElement, box: LeafBox, r: Rect, items: Registry, pick: Pick): void {
  const lines = subLines(box.sub);
  const cls = `card${box.column === null ? "" : " outside"}${box.off ? " off" : ""}`;
  const g = el("g", { class: cls, style: colorStyle(box.color), "data-id": box.id }, layer);
  el("rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: box.column === null ? 6 : 14 }, g);
  openBadge(g, box.open, r.x + r.w - 2, r.y + 2, false);
  const cx = r.x + r.w / 2;
  const top = r.y + r.h / 2 - (CARD.ls + (lines.length > 0 ? 5 + lines.length * CARD.lh : 0)) / 2;
  text(g, { x: cx, y: top + CARD.ls * 0.8, class: CARD.lbl, "text-anchor": "middle" }, box.label);

  for (const [i, line] of lines.entries()) {
    const y = top + CARD.ls + 5 + i * CARD.lh + CARD.ss * 0.85;
    text(g, { x: cx, y, class: CARD.sub, "text-anchor": "middle" }, line);
  }

  onActivate(g, box.label, () => {
    pick({ type: "select", id: box.id });
  });

  register(items, box.id, g);
}

function drawGhost(layer: SVGGElement, ghost: Ghost, r: Rect, items: Registry, pick: Pick): void {
  const cls = `ghost${ghost.outside ? " outside" : ""}${ghost.off ? " off" : ""}`;
  const g = el("g", { class: cls, style: colorStyle(ghost.color), "data-id": ghost.id }, layer);
  el("rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: 26 }, g);
  text(
    g,
    { x: r.x + r.w / 2, y: r.y + 33, class: GHOST.cls, "text-anchor": "middle" },
    ghost.label,
  );
  openBadge(g, ghost.open, r.x + r.w - 10, r.y + 4, false);
  onActivate(g, ghost.label, () => {
    pick({ type: "select", id: ghost.id });
  });

  register(items, ghost.id, g);
}

function drawArrow(
  layer: SVGGElement,
  arrow: Arrow,
  mode: Mode,
  pts: readonly Point[],
  label: Rect | null,
): ArrowEl {
  const g = el("g", { class: `flow ${arrow.kind}`, "pointer-events": "none" }, layer);
  const path = arrowPath(g, rounded(pts, mode === "packed" ? 9 : 7), arrow.kind, arrow.two);

  if (label !== null) {
    const content = arrowText(arrow, mode);
    text(
      g,
      { x: label.x + label.w / 2, y: label.y + 13, class: "flow-label", "text-anchor": "middle" },
      content,
    );
  }

  return { arrow, g, path, marker: path.getAttribute("marker-end") ?? "" };
}

export async function drawView(
  view: View,
  layer: SVGGElement,
  packing: Packing,
  pins: Pins,
  words: Words,
  pick: Pick,
): Promise<Drawn> {
  const mode: Mode = view.boxes.some((b) => b.kind === "container") ? "packed" : "layered";
  const items = itemsOf(view);
  const ends = endsOf(view, items);

  const laid =
    mode === "packed"
      ? await packedView(view, items, ends, packing, pins)
      : await layeredView(view, items, ends);

  layer.classList.add("view", mode);
  // Boxes, then arrows, then cards, pills and chips on top: an arrow's end never hides a label.
  const frames = el("g", {}, layer);
  const arrowLayer = el("g", {}, layer);
  const top = el("g", {}, layer);
  const registry: Registry = new Map();

  const rectOf = (id: string): Rect => {
    const r = laid.rects.get(id);

    if (r === undefined) {
      throw new Error(`layout placed no item ${id}`);
    }

    return r;
  };

  for (const item of items) {
    const r = rectOf(item.id);

    switch (item.figure.kind) {
      case "box": {
        drawBox(frames, top, item.figure.box, item.figure.cells, r, registry, words, pick);
        break;
      }

      case "card": {
        drawCard(top, item.figure.box, r, registry, pick);
        break;
      }

      case "ghost": {
        drawGhost(top, item.figure.ghost, r, registry, pick);
        break;
      }

      default: {
        const unknown: never = item.figure;

        throw new Error(`unknown figure ${JSON.stringify(unknown)}`);
      }
    }
  }

  const arrows = view.arrows.flatMap((a, i): ArrowEl[] => {
    const pts = laid.routes[i] ?? null;

    return pts === null ? [] : [drawArrow(arrowLayer, a, mode, pts, laid.labels[i] ?? null)];
  });

  const rects = new Map(view.boxes.map((b): [string, Rect] => [b.id, rectOf(b.id)]));

  return {
    view,
    mode,
    layer,
    size: laid.size,
    frame: laid.frame,
    rects,
    items: registry,
    arrows,
    avoidError: laid.avoidError,
  };
}
