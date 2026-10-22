// The overview, readable at its own scale:
// 1. Boxes: a zone frame with its bricks as chips; a nesting zone's own
//    bricks as chips without a frame; a service outside as a pill.
// 2. Placement: ELK's rectpacking packs the zones inside each nesting zone, in
//    data order (it keeps the order it is given, so reordering the children
//    of a node in the map's tree moves zones on the overview). Every nesting zone aims at
//    the aspect of the screen, less the room of the two side columns, so a
//    wide screen gets a wide plan: place() packs a few times, correcting the
//    aspect from the height each pass gives. The outside services and the ext zones stand in a
//    column on each side (side "in" left, "out" right), each as near as it can
//    get to the height of the server boxes it talks to. Arrows are not part of
//    this placement: ELK's layered placement keeps corridors for them and made
//    the overview too large to read unzoomed.
// 3. Arrows: libavoid (avoid.ts) routes one arrow per pair of boxes, around
//    every box and the nesting zones' title strips. On failure (libavoid.wasm
//    unreachable) the overview is drawn without arrows and the panel says why:
//    never block the page.
// 4. Labels: each takes the longest segment of its arrow where the label hits
//    no box, no other label and no other arrow; failing that, one that hits no
//    box and no label; failing that, the longest segment.
import type { ElkNode } from "elkjs/lib/elk.bundled.js";
import ELK from "elkjs/lib/elk.bundled.js";

import { routeLinks } from "./avoid.ts";
import { drawZone } from "./frame.ts";
import {
  OUT,
  arrival,
  got,
  isZone,
  isZoneRef,
  kidsOfZone,
  links,
  nestOrder,
  nestsZone,
  node,
  outside,
  realId,
  zone,
} from "./graph.ts";
import { ROOT_COORDS, rectOf } from "./layout.ts";
import type { NavEvent, Point, Rect } from "./machine.ts";
import type { Size } from "./measure.ts";
import { textWidth, titleWidth } from "./measure.ts";
import type { Edge } from "./model.ts";
import { OWN, PLAN, groupOf, zoneBox } from "./plan.ts";
import type { ArrowEl, Registry } from "./svg.ts";
import { arrowPath, el, onActivate, openBadge, register, rounded, text } from "./svg.ts";

export type Overview = {
  readonly size: Size;
  readonly rects: ReadonlyMap<string, Rect>;
  readonly nodeEls: Registry;
  readonly arrows: readonly ArrowEl[];
  readonly avoidError: string | null;
};

type Chip = { readonly id: string; readonly x: number; readonly y: number; readonly w: number };

// ext: the brick a pill stands for; null for a zone's block of chips.
type Block = {
  readonly w: number;
  readonly h: number;
  readonly chips: readonly Chip[];
  readonly padX: number;
  readonly top: number;
  readonly header: boolean;
  readonly ext: string | null;
};

type Flow = {
  readonly from: string;
  readonly to: string;
  readonly bricks: readonly string[];
  readonly two: boolean;
  readonly kind: string;
  readonly label: string;
};

type Pick = (ev: NavEvent) => void;

const CHIP = { h: 34, gap: 9, pad: 13, maxW: 560 };

const COL_GAP = 150;

const PACK_GAP = 56;

const MARGIN = 40;

function chipBlock(id: string, ids: readonly string[], header: boolean): Block {
  const widths = ids.map((b) => Math.ceil(textWidth(node(b).label, "ov-chip-t")) + 2 * CHIP.pad);
  const total = widths.reduce((a, w) => a + w + CHIP.gap, 0);
  const headW = header ? titleWidth(id, "ov") : 0;
  // Chips wrap at a width that makes the block about 2.6 times wider than tall.
  const target = Math.max(headW, Math.min(CHIP.maxW, Math.sqrt(total * (CHIP.h + CHIP.gap) * 2.6)));
  const chips: Chip[] = [];
  let x = 0;
  let y = 0;
  let maxX = 0;

  for (const [i, b] of ids.entries()) {
    const w = widths[i] ?? 0;

    if (x > 0 && x + w > target) {
      x = 0;
      y += CHIP.h + CHIP.gap;
    }

    chips.push({ id: b, x, y, w });
    x += w + CHIP.gap;
    maxX = Math.max(maxX, x - CHIP.gap);
  }

  const padX = header ? 20 : 6;
  const top = header ? 80 : 6;
  const bottom = header ? 20 : 6;

  return {
    w: Math.ceil(Math.max(maxX, headW) + 2 * padX),
    h: top + y + CHIP.h + bottom,
    chips,
    padX,
    top,
    header,
    ext: null,
  };
}

function blocksOf(): Map<string, Block> {
  const blocks = new Map<string, Block>();

  for (const z of PLAN.zones) {
    const own = PLAN.nodes.filter((n) => n.zone === z.id).map((n) => n.id);

    if (nestsZone(z.id)) {
      blocks.set(z.id + OWN, chipBlock(z.id + OWN, own, false));
    } else {
      blocks.set(z.id, chipBlock(z.id, own, true));
    }
  }

  for (const n of outside) {
    const pill = (): Block => ({
      w: Math.ceil(textWidth(n.label, "ov-ext-t")) + 44,
      h: 52,
      chips: [],
      padX: 0,
      top: 0,
      header: false,
      ext: n.id,
    });

    if (n.side !== "out") {
      blocks.set(n.id, pill());
    }

    if (n.side !== "in") {
      blocks.set(n.id + (n.side === "both" ? OUT : ""), pill());
    }
  }

  return blocks;
}

// The bricks' arrows grouped by the pair of boxes they join. An overview label
// (a "z:" arrow, a Link with a zone end) names the arrow; with `two`, it also merges
// both directions into one arrow. Without a label, the arrow carries the
// first two labels of its bricks.
const refBox = (ref: string, arriving: boolean): string => {
  if (!isZoneRef(ref)) {
    return arriving ? arrival(ref) : ref;
  }

  return zoneBox(PLAN, ref.slice(2));
};

const boxOfNode = (id: string): string => groupOf(PLAN, node(id)) ?? id;

type FlowSum = {
  from: string;
  to: string;
  bricks: Set<string>;
  labels: string[];
  kinds: Set<string>;
  two: boolean;
  named: Edge | undefined;
};

function flowsOf(): Flow[] {
  const named = new Map<string, Edge>();

  for (const e of PLAN.edges) {
    if (isZoneRef(e.from) || isZoneRef(e.to)) {
      named.set(`${refBox(e.from, false)}>${refBox(e.to, true)}`, e);
    }
  }

  const sums = new Map<string, FlowSum>();

  for (const e of links) {
    let a = boxOfNode(e.from);
    let b = arrival(e.to) === e.to ? boxOfNode(e.to) : arrival(e.to);

    if (a === b) {
      continue;
    }

    if (named.get(`${b}>${a}`)?.two === true) {
      [a, b] = [b, a];
    }

    const key = `${a}>${b}`;

    const sum = sums.get(key) ?? {
      from: a,
      to: b,
      bricks: new Set<string>(),
      labels: [],
      kinds: new Set<string>(),
      two: false,
      named: named.get(key),
    };

    sums.set(key, sum);
    sum.bricks.add(e.from).add(e.to);

    if (!sum.labels.includes(e.label)) {
      sum.labels.push(e.label);
    }

    sum.kinds.add(e.kind ?? "");
    sum.two ||= e.two === true || sum.named?.two === true;
  }

  return [...sums.values()].map((s) => ({
    from: s.from,
    to: s.to,
    bricks: [...s.bricks],
    two: s.two,
    kind: s.kinds.size === 1 ? ([...s.kinds][0] ?? "") : "",
    label: s.named?.label ?? s.labels.slice(0, 2).join(" · "),
  }));
}

const packedLeaf = (blocks: ReadonlyMap<string, Block>, id: string): ElkNode => {
  const b = got(blocks, id, "overview block");

  return { id, width: b.w, height: b.h };
};

function pack(blocks: ReadonlyMap<string, Block>, zid: string, ratio: number): ElkNode {
  return {
    id: zid,
    layoutOptions: {
      "elk.algorithm": "rectpacking",
      "elk.aspectRatio": ratio.toFixed(2),
      "elk.padding": "[top=96,left=30,bottom=30,right=30]",
      "elk.spacing.nodeNode": String(PACK_GAP),
      "elk.nodeSize.constraints": "MINIMUM_SIZE",
      "elk.nodeSize.minimum": `(${Math.ceil(titleWidth(zid, "ov"))}, 90)`,
      ...ROOT_COORDS,
    },
    children: [
      ...kidsOfZone(zid).map((k) =>
        nestsZone(k) ? pack(blocks, k, ratio) : packedLeaf(blocks, k),
      ),
      packedLeaf(blocks, zid + OWN),
    ],
  };
}

const servers = PLAN.zones.filter((z) => z.parent === undefined && z.ext !== true);

async function packServers(
  blocks: ReadonlyMap<string, Block>,
  rect: Map<string, Rect>,
  ratio: number,
): Promise<Size> {
  const [only] = servers;

  const center: ElkNode =
    servers.length === 1 && only !== undefined
      ? pack(blocks, only.id, ratio)
      : {
          id: "center",
          layoutOptions: {
            "elk.algorithm": "rectpacking",
            "elk.aspectRatio": ratio.toFixed(2),
            "elk.spacing.nodeNode": String(PACK_GAP),
            ...ROOT_COORDS,
          },
          children: servers.map((z) => pack(blocks, z.id, ratio)),
        };

  const laid = await new ELK().layout(center);
  const size = { w: laid.width ?? 0, h: laid.height ?? 0 };

  if (servers.length === 1 && only !== undefined) {
    rect.set(only.id, { x: 0, y: 0, ...size });
  }

  const walk = (n: ElkNode): void => {
    for (const c of n.children ?? []) {
      rect.set(c.id, rectOf(c));
      walk(c);
    }
  };

  walk(laid);

  return size;
}

function sideOf(id: string, b: Block): "in" | "out" | null {
  if (b.ext !== null) {
    return id.endsWith(OUT) || node(id).side === "out" ? "out" : "in";
  }

  return isZone(id) && zone(id).ext === true ? (zone(id).side ?? null) : null;
}

// One side column: each box as near as it can get to the mean height of the
// server boxes it talks to. A box that only talks to a column-mate goes right
// after it.
function column(
  ids: readonly string[],
  x: number,
  alignRight: boolean,
  flows: readonly Flow[],
  blocks: ReadonlyMap<string, Block>,
  rect: Map<string, Rect>,
): void {
  const partners = (id: string): string[] =>
    flows
      .values()
      .filter((f) => f.from === id || f.to === id)
      .map((f) => (f.from === id ? f.to : f.from))
      .toArray();

  const want = (id: string): number | null => {
    const ys = partners(id).flatMap((o) => {
      const r = rect.get(o);

      return r === undefined ? [] : [r.y + r.h / 2];
    });

    return ys.length > 0 ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
  };

  const order = ids
    .filter((id) => want(id) !== null)
    .toSorted((a, b) => (want(a) ?? 0) - (want(b) ?? 0));

  for (const id of ids.filter((i) => want(i) === null)) {
    const mate = partners(id).find((p) => order.includes(p));
    order.splice(mate === undefined ? order.length : order.indexOf(mate) + 1, 0, id);
  }

  let bottom = -Infinity;

  for (const id of order) {
    const b = got(blocks, id, "overview block");
    const wish = want(id) ?? bottom + 44 + b.h / 2;
    const y = Math.max(wish - b.h / 2, bottom + 44);
    rect.set(id, { x: alignRight ? x - b.w : x, y, w: b.w, h: b.h });
    bottom = y + b.h;
  }
}

type Placed = { readonly rect: ReadonlyMap<string, Rect>; readonly size: Size };

// The packing's aspect stays between these bounds whatever the screen.
const RATIO = { min: 0.6, max: 4, passes: 3, settled: 0.05 };

const clampRatio = (r: number): number => Math.min(RATIO.max, Math.max(RATIO.min, r));

// screen: width / height of the drawing area. The server boxes aim at the
// aspect that, with the side columns added, matches it.
async function place(
  blocks: ReadonlyMap<string, Block>,
  flows: readonly Flow[],
  screen: number,
): Promise<Placed> {
  const ids = [...blocks.keys()];
  const left = ids.filter((id) => sideOf(id, got(blocks, id, "overview block")) === "in");
  const right = ids.filter((id) => sideOf(id, got(blocks, id, "overview block")) === "out");
  const leftW = Math.max(0, ...left.map((id) => got(blocks, id, "overview block").w));
  const rightW = Math.max(0, ...right.map((id) => got(blocks, id, "overview block").w));
  const sidesW = leftW + rightW + 2 * COL_GAP + 2 * MARGIN;
  let ratio = clampRatio(screen);
  let packed = new Map<string, Rect>();
  let server = await packServers(blocks, packed, ratio);

  for (let pass = 1; pass < RATIO.passes; pass++) {
    const next = clampRatio(screen - sidesW / Math.max(1, server.h));

    if (Math.abs(next - ratio) < RATIO.settled) {
      break;
    }

    ratio = next;
    packed = new Map<string, Rect>();
    server = await packServers(blocks, packed, ratio);
  }

  const sx = leftW + COL_GAP;

  const rect = new Map(
    [...packed].map(([id, r]): [string, Rect] => [id, { x: r.x + sx, y: r.y, w: r.w, h: r.h }]),
  );

  column(left, leftW, true, flows, blocks, rect);
  column(right, sx + server.w + COL_GAP, false, flows, blocks, rect);
  const all = [...rect.values()];
  const minY = Math.min(...all.map((r) => r.y));
  const maxY = Math.max(...all.map((r) => r.y + r.h));
  const maxX = Math.max(...all.map((r) => r.x + r.w));

  const shifted = new Map(
    [...rect].map(([id, r]): [string, Rect] => [
      id,
      { x: r.x + MARGIN, y: r.y + MARGIN - minY, w: r.w, h: r.h },
    ]),
  );

  return { rect: shifted, size: { w: maxX + 2 * MARGIN, h: maxY - minY + 2 * MARGIN } };
}

const hits = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

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

// Candidate spots along the arrow, longest segment first: above or below a
// flat segment, right or left of an upright one.
function spotsOf(pts: readonly Point[], w: number, h: number): Rect[] {
  const spots: Rect[] = [];

  for (const [p, q] of segmentsOf(pts).toSorted((s, t) => segmentLength(t) - segmentLength(s))) {
    const flat = Math.abs(q[1] - p[1]) < 1;

    for (const t of [0.5, 0.3, 0.7]) {
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

function labelSpots(
  routes: ReadonlyArray<Point[] | null>,
  flows: readonly Flow[],
  obstacles: readonly Rect[],
): Array<Rect | null> {
  const segBoxes = routes.map((pts) =>
    pts === null ? [] : segmentsOf(pts).map((s) => segmentBox(s)),
  );

  const taken: Rect[] = [];

  const free = (s: Rect): boolean =>
    !obstacles.some((o) => hits(s, o)) && !taken.some((o) => hits(s, o));

  return routes.map((pts, i) => {
    const label = flows[i]?.label ?? "";

    if (pts === null || label === "") {
      return null;
    }

    const spots = spotsOf(pts, Math.ceil(textWidth(label, "ov-label")) + 8, 17);
    const others = segBoxes.filter((_, j) => j !== i).flat();

    const spot =
      spots.find((s) => free(s) && !others.some((o) => hits(s, o))) ??
      spots.find((s) => free(s)) ??
      spots[0] ??
      null;

    if (spot !== null) {
      taken.push(spot);
    }

    return spot;
  });
}

function drawPill(layer: SVGGElement, r: Rect, id: string, pick: Pick): SVGGElement {
  const n = node(id);
  const g = el("g", { class: "ov-ext", "data-brick": id }, layer);
  el("rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: 26 }, g);
  text(g, { x: r.x + r.w / 2, y: r.y + 33, class: "ov-ext-t", "text-anchor": "middle" }, n.label);
  openBadge(g, n.info, r.x + r.w - 26, r.y + 2, 7);
  onActivate(g, n.label, () => {
    pick({ type: "node", id: n.id });
  });

  return g;
}

function drawChip(layer: SVGGElement, r: Rect, b: Block, c: Chip, pick: Pick): SVGGElement {
  const n = node(c.id);

  const g = el(
    "g",
    {
      class: `ov-chip${n.kind === "off" ? " off" : ""}`,
      style: `--zc: var(${n.color})`,
      "data-brick": c.id,
    },
    layer,
  );

  const x = r.x + b.padX + c.x;
  const y = r.y + b.top + c.y;
  el("rect", { x, y, width: c.w, height: CHIP.h, rx: 5 }, g);
  text(g, { x: x + c.w / 2, y: y + 23, class: "ov-chip-t", "text-anchor": "middle" }, n.label);
  openBadge(g, n.info, x + c.w - 2, y + 2, 6);
  onActivate(g, n.label, () => {
    pick({ type: "node", id: n.id });
  });

  return g;
}

type Boxes = { readonly rects: ReadonlyMap<string, Rect>; readonly nodeEls: Registry };

function drawBoxes(
  frames: SVGGElement,
  chips: SVGGElement,
  blocks: ReadonlyMap<string, Block>,
  rect: ReadonlyMap<string, Rect>,
  pick: Pick,
): Boxes {
  const rects = new Map<string, Rect>();
  const nodeEls: Registry = new Map();

  const onZone = (id: string): void => {
    pick({ type: "zone", id });
  };

  for (const z of servers.flatMap((s) => nestOrder(s.id)).filter((zid) => nestsZone(zid))) {
    const r = got(rect, z, "overview rect");
    rects.set(z, r);
    drawZone(frames, z, r, "ov", onZone);
  }

  for (const [id, b] of blocks) {
    const r = got(rect, id, "overview rect");

    if (b.ext !== null) {
      register(nodeEls, b.ext, drawPill(chips, r, b.ext, pick));
      continue;
    }

    rects.set(id, r);

    if (b.header) {
      drawZone(frames, id, r, "ov", onZone).dataset["zone"] = id;
    }

    for (const c of b.chips) {
      register(nodeEls, c.id, drawChip(chips, r, b, c, pick));
    }
  }

  return { rects, nodeEls };
}

function drawFlows(
  layer: SVGGElement,
  routes: ReadonlyArray<Point[] | null>,
  flows: readonly Flow[],
  spots: ReadonlyArray<Rect | null>,
): ArrowEl[] {
  return flows.flatMap((f, i): ArrowEl[] => {
    const pts = routes[i] ?? null;

    if (pts === null) {
      return [];
    }

    const g = el("g", { class: `ov-flow ${f.kind}`, "pointer-events": "none" }, layer);
    const path = arrowPath(g, rounded(pts, 9), f.kind, f.two);
    const spot = spots[i] ?? null;

    if (spot !== null) {
      text(
        g,
        { x: spot.x + spot.w / 2, y: spot.y + 13, class: "ov-label", "text-anchor": "middle" },
        f.label,
      );
    }

    return [
      {
        from: realId(f.from),
        to: realId(f.to),
        bricks: f.bricks,
        g,
        path,
        marker: path.getAttribute("marker-end") ?? "",
        two: f.two,
      },
    ];
  });
}

type Routed = { readonly routes: Array<Point[] | null>; readonly error: string | null };

async function routeFlows(
  boxes: ReadonlyMap<string, Rect>,
  strips: readonly Rect[],
  flows: readonly Flow[],
): Promise<Routed> {
  try {
    return { routes: await routeLinks(boxes, strips, flows), error: null };
  } catch (error: unknown) {
    return {
      routes: flows.map(() => null),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// screen: width / height of the drawing area the overview should fill.
export async function drawOverview(
  layer: SVGGElement,
  pick: Pick,
  screen: number,
): Promise<Overview> {
  const blocks = blocksOf();
  const flows = flowsOf();
  const { rect, size } = await place(blocks, flows, screen);

  // 3. Arrows, around every box and the title strip of each nesting zone.
  const strips = PLAN.zones
    .filter((z) => nestsZone(z.id))
    .map((z): Rect => {
      const r = got(rect, z.id, "overview rect");

      return { x: r.x, y: r.y, w: titleWidth(z.id, "ov") + 20, h: 84 };
    });

  const boxes = new Map(
    [...blocks.keys()].map((id): [string, Rect] => [id, got(rect, id, "overview rect")]),
  );

  const { routes, error } = await routeFlows(boxes, strips, flows);
  const spots = labelSpots(routes, flows, [...boxes.values(), ...strips]);
  // Frames, then arrows, then chips and pills on top.
  const frames = el("g", {}, layer);
  const arrowLayer = el("g", {}, layer);
  const chips = el("g", {}, layer);
  const { rects, nodeEls } = drawBoxes(frames, chips, blocks, rect, pick);
  const arrows = drawFlows(arrowLayer, routes, flows, spots);

  return { size, rects, nodeEls, arrows, avoidError: error };
}
