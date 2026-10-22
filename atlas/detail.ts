import { drawZone } from "./frame.ts";
import type { Graph } from "./graph.ts";
import { OUT, OWN, realId } from "./graph.ts";
import type { Group, LayoutEdge, Leaf } from "./layout.ts";
import { elkNested } from "./layout.ts";
import type { NavEvent, Point, Rect } from "./machine.ts";
import type { Size } from "./measure.ts";
import { cardSize, subLines, textHeight, textOf, textWidth, titleWidth } from "./measure.ts";
import type { Brick } from "./model.ts";
import { edgeText } from "./model.ts";
import type { ArrowEl, Registry } from "./svg.ts";
import { arrowPath, el, onActivate, openBadge, register, rounded, text } from "./svg.ts";
import type { Words } from "./words.ts";

export type Detail = {
  readonly size: Size;
  readonly rects: ReadonlyMap<string, Rect>;
  readonly zoneEls: Registry;
  readonly nodeEls: Registry;
  readonly arrows: readonly ArrowEl[];
};

const MARGIN = 40;

function groups(graph: Graph): Map<string, Group> {
  const all = new Map<string, Group>();

  for (const z of graph.plan.zones) {
    const nesting = graph.nestsZone(z.id);
    all.set(z.id, {
      pad: nesting ? "[top=74,left=28,bottom=28,right=28]" : "[top=66,left=20,bottom=20,right=20]",
      minW: titleWidth(graph, z.id, "dt"),
    });

    if (nesting) {
      all.set(z.id + OWN, { pad: "[top=14,left=14,bottom=14,right=14]" });
    }
  }

  return all;
}

function leafOf(id: string, n: Brick, group: string | null): Leaf {
  const { w, h } = cardSize(n);

  return { id, w, h, group };
}

const leaves = (graph: Graph): Leaf[] => [
  ...graph.plan.nodes.map((n) => leafOf(n.id, n, graph.groupOf(n))),
  ...graph.outside.filter((n) => n.side === "both").map((n) => leafOf(n.id + OUT, n, null)),
];

// An arrow that leaves a service outside the server toward a brick inside is
// laid out reversed: ELK's layers run left to right, so a pure source would
// otherwise land on the left, among the inbound side.
const layoutEdges = (graph: Graph): LayoutEdge[] =>
  graph.links.map((e) => ({
    from: e.from,
    to: graph.arrival(e.to),
    label: edgeText(e),
    flip: graph.node(e.from).side === "out" && graph.node(e.to).zone !== null,
  }));

function drawBrick(
  graph: Graph,
  layer: SVGGElement,
  id: string,
  r: Rect,
  pick: (ev: NavEvent) => void,
): SVGGElement {
  const n = graph.node(realId(id));
  const t = textOf(n);
  const lines = subLines(n);
  const cls = `brick${n.zone === null ? " ext" : ""}${n.kind === "off" ? " off" : ""}`;
  const g = el("g", { class: cls, style: `--zc: var(${n.color})` }, layer);
  el(
    "rect",
    { x: r.x, y: r.y, width: r.w, height: r.h, rx: n.zone === null ? 12 : 4, class: "box" },
    g,
  );
  openBadge(g, n.info, r.x + r.w - (n.zone === null ? 12 : 2), r.y + 2, 4);
  const cx = r.x + r.w / 2;
  const top = r.y + r.h / 2 - textHeight(t, lines.length) / 2 - 1;
  text(g, { x: cx, y: top + t.ls * 0.8, class: t.lbl, "text-anchor": "middle" }, n.label);

  for (const [i, line] of lines.entries()) {
    const y = top + t.ls + 5 + i * t.lh + t.ss * 0.85;
    text(g, { x: cx, y, class: t.sub, "text-anchor": "middle" }, line);
  }

  onActivate(g, n.label, () => {
    pick({ type: "node", id: n.id });
  });

  return g;
}

export async function drawDetail(
  graph: Graph,
  words: Words,
  layer: SVGGElement,
  x0: number,
  pick: (ev: NavEvent) => void,
): Promise<Detail> {
  const all = leaves(graph);

  const laid = await elkNested(groups(graph), graph.parents, all, layoutEdges(graph), (t) => ({
    width: Math.ceil(textWidth(t, "elabel")) + 6,
    height: 10,
  }));

  const shift = (b: Rect): Rect => ({ x: b.x + x0 + MARGIN, y: b.y + MARGIN, w: b.w, h: b.h });

  const box = (id: string): Rect => {
    const b = laid.boxes.get(id);

    if (b === undefined) {
      throw new Error(`ELK placed no box ${id}`);
    }

    return shift(b);
  };

  // Layers: frames, then arrows, then bricks on top, so an arrow's end never hides a brick's text.
  const zl = el("g", {}, layer);
  const al = el("g", {}, layer);
  const bl = el("g", {}, layer);
  const rects = new Map<string, Rect>();
  const zoneEls: Registry = new Map();

  for (const zid of graph.roots.flatMap((z) => graph.nestOrder(z.id))) {
    rects.set(zid, box(zid));

    if (graph.nestsZone(zid)) {
      rects.set(zid + OWN, box(zid + OWN));
    }

    register(
      zoneEls,
      zid,
      drawZone(graph, words, zl, zid, box(zid), "dt", (id) => pick({ type: "zone", id })),
    );
  }

  const nodeEls: Registry = new Map();

  for (const l of all) {
    register(nodeEls, realId(l.id), drawBrick(graph, bl, l.id, box(l.id), pick));
  }

  const arrows = laid.paths.map((p, i): ArrowEl => {
    const e = graph.links[i];

    if (e === undefined) {
      throw new Error(`ELK returned an extra path ${i}`);
    }

    const g = el("g", { class: `edge ${e.kind ?? ""}`, "pointer-events": "none" }, al);
    const pts = p.pts.map(([x, y]): Point => [x + x0 + MARGIN, y + MARGIN]);
    const path = arrowPath(g, rounded(pts, 7), e.kind, e.two === true);

    if (p.label !== null) {
      const lx = p.label.x + x0 + MARGIN + p.label.w / 2;
      text(
        g,
        { x: lx, y: p.label.y + MARGIN + 8, class: "elabel", "text-anchor": "middle" },
        edgeText(e),
      );
    }

    return {
      from: e.from,
      to: e.to,
      bricks: [e.from, e.to],
      g,
      path,
      marker: path.getAttribute("marker-end") ?? "",
      two: e.two === true,
    };
  });

  return {
    size: { w: laid.w + 2 * MARGIN, h: laid.h + 2 * MARGIN },
    rects,
    zoneEls,
    nodeEls,
    arrows,
  };
}
