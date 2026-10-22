// ELK lays out each zone on its own (its default hierarchy handling,
// SEPARATE_CHILDREN): a zone stays compact. The other mode, INCLUDE_CHILDREN,
// layers the whole graph at once and stretches every zone across the layers
// its bricks fall in: the drawing came out mostly empty.
// In this mode ELK does not route an arrow that crosses a zone border (it
// returns no route at all). So each such arrow is cut into one segment per
// level, joined by ports on the zone borders: brick → port of its zone → port
// of the parent zone → … → the target. ELK places the ports and routes each
// segment; elkNested glues the segments back into one polyline.
// Other traps:
//   - coordinates: without the two ROOT options below, a child's x/y is
//     relative to its parent and an edge's points to its container;
//   - labels need a width and a height: ELK then keeps room for them;
//   - do not enable elk.layered.compaction.postCompaction: with ports on
//     compound nodes it throws "Invalid hitboxes for scanline constraint
//     calculation";
//   - elk.bundled.js does not start under Bun (Bun's global Worker sends it
//     down the wrong path); a script that lays out the plan outside a browser
//     must run under Node.
import type { ElkExtendedEdge, ElkLabel, ElkNode, LayoutOptions } from "elkjs/lib/elk.bundled.js";
import ELK from "elkjs/lib/elk.bundled.js";

import type { Point, Rect } from "./machine.ts";

export const LAYERED: LayoutOptions = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.spacing.nodeNodeBetweenLayers": "52",
  "elk.layered.spacing.edgeNodeBetweenLayers": "20",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "12",
  "elk.spacing.nodeNode": "28",
  "elk.spacing.edgeNode": "18",
  "elk.spacing.edgeEdge": "12",
  "elk.spacing.edgeLabel": "3",
  "elk.edgeLabels.placement": "CENTER",
};

export const ROOT_COORDS: LayoutOptions = {
  "org.eclipse.elk.json.shapeCoords": "ROOT",
  "org.eclipse.elk.json.edgeCoords": "ROOT",
};

// A zone as an ELK compound node; minW keeps its title inside the frame.
export type Group = { readonly pad: string; readonly minW?: number };

// A box to place; group null = at the root.
export type Leaf = {
  readonly id: string;
  readonly w: number;
  readonly h: number;
  readonly group: string | null;
};

// flip lays the arrow out reversed and draws it the right way round.
export type LayoutEdge = {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly flip: boolean;
};

export type LabelSize = { readonly width: number; readonly height: number };

export type LaidPath = { readonly pts: Point[]; readonly label: Rect | null };

export type Laid = {
  readonly w: number;
  readonly h: number;
  readonly boxes: ReadonlyMap<string, Rect>;
  readonly paths: readonly LaidPath[];
};

type Compound = {
  readonly node: ElkNode;
  readonly children: ElkNode[];
  readonly edges: ElkExtendedEdge[];
};

type Cut = { readonly ids: readonly string[]; readonly mid: string; readonly flip: boolean };

export function rectOf(n: ElkNode | ElkLabel): Rect {
  if (n.x === undefined || n.y === undefined || n.width === undefined || n.height === undefined) {
    throw new Error(`ELK returned ${n.id ?? "a box"} without a position or a size`);
  }

  return { x: n.x, y: n.y, w: n.width, h: n.height };
}

function compound(id: string, layoutOptions: LayoutOptions): Compound {
  const children: ElkNode[] = [];
  const edges: ElkExtendedEdge[] = [];

  return { node: { id, layoutOptions, children, edges, ports: [] }, children, edges };
}

function groupOptions(g: Group): LayoutOptions {
  const sized: LayoutOptions =
    g.minW === undefined
      ? {}
      : {
          "elk.nodeSize.constraints": "MINIMUM_SIZE",
          "elk.nodeSize.minimum": `(${Math.ceil(g.minW)}, 90)`,
        };

  return { ...LAYERED, "elk.padding": g.pad, ...sized };
}

class Graph {
  readonly root = compound("root", { ...LAYERED, ...ROOT_COORDS });
  private readonly groups = new Map<string, Compound>();
  private readonly groupOfLeaf = new Map<string, string | null>();

  constructor(
    groups: ReadonlyMap<string, Group>,
    private readonly parentOf: ReadonlyMap<string, string>,
    leaves: readonly Leaf[],
  ) {
    for (const [id, g] of groups) {
      this.groups.set(id, compound(id, groupOptions(g)));
    }

    for (const [id, c] of this.groups) {
      this.container(this.parentOf.get(id) ?? null).children.push(c.node);
    }

    for (const l of leaves) {
      this.groupOfLeaf.set(l.id, l.group);
      this.container(l.group).children.push({ id: l.id, width: l.w, height: l.h });
    }
  }

  container(group: string | null): Compound {
    if (group === null) {
      return this.root;
    }

    const c = this.groups.get(group);

    if (c === undefined) {
      throw new Error(`ELK: unknown group ${group}`);
    }

    return c;
  }

  // The groups around a leaf, outermost first.
  pathOf(id: string): string[] {
    const path: string[] = [];

    for (let g = this.groupOfLeaf.get(id) ?? null; g !== null; g = this.parentOf.get(g) ?? null) {
      path.unshift(g);
    }

    return path;
  }

  addPort(group: string, port: string): void {
    const c = this.container(group);
    c.node.ports?.push({ id: port, width: 1, height: 1 });
  }

  // One arrow, cut at every zone border it crosses (see the top of this file).
  cut(e: LayoutEdge, i: number, labelSize: (t: string) => LabelSize): Cut {
    const [from, to] = e.flip ? [e.to, e.from] : [e.from, e.to];
    const pu = this.pathOf(from);
    const pv = this.pathOf(to);
    // k = depth of the deepest zone both ends share: the middle segment lives
    // there (or at the root).
    let k = 0;

    while (k < pu.length && k < pv.length && pu[k] === pv[k]) {
      k += 1;
    }

    const up: string[] = [];
    const down: string[] = [];
    let src = from;
    let dst = to;

    for (let d = pu.length - 1; d >= k; d -= 1) {
      const group = pu[d] ?? "";
      this.addPort(group, `p${i}u${d}`);
      this.container(group).edges.push({
        id: `e${i}u${d}`,
        sources: [src],
        targets: [`p${i}u${d}`],
      });
      up.push(`e${i}u${d}`);
      src = `p${i}u${d}`;
    }

    for (let d = pv.length - 1; d >= k; d -= 1) {
      const group = pv[d] ?? "";
      this.addPort(group, `p${i}d${d}`);
      this.container(group).edges.push({
        id: `e${i}d${d}`,
        sources: [`p${i}d${d}`],
        targets: [dst],
      });
      down.unshift(`e${i}d${d}`);
      dst = `p${i}d${d}`;
    }

    const labels = e.label === "" ? [] : [{ text: e.label, ...labelSize(e.label) }];
    const middle = k > 0 ? this.container(pu[k - 1] ?? null) : this.root;
    middle.edges.push({ id: `e${i}m`, sources: [src], targets: [dst], labels });

    return { ids: [...up, `e${i}m`, ...down], mid: `e${i}m`, flip: e.flip };
  }
}

function collect(n: ElkNode, edges: Map<string, ElkExtendedEdge>, boxes: Map<string, Rect>): void {
  for (const e of n.edges ?? []) {
    edges.set(e.id, e);
  }

  for (const c of n.children ?? []) {
    boxes.set(c.id, rectOf(c));
    collect(c, edges, boxes);
  }
}

function laidEdge(edges: ReadonlyMap<string, ElkExtendedEdge>, id: string): ElkExtendedEdge {
  const e = edges.get(id);

  if (e === undefined) {
    throw new Error(`ELK returned no edge ${id}`);
  }

  return e;
}

// Glues the segments of one arrow back into one polyline.
function glue(cut: Cut, edges: ReadonlyMap<string, ElkExtendedEdge>): LaidPath {
  const pts: Point[] = [];

  for (const id of cut.ids) {
    const s = laidEdge(edges, id).sections?.[0];

    if (s === undefined) {
      throw new Error(`ELK returned no route for ${id}`);
    }

    for (const p of [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]) {
      const q = pts.at(-1);

      // Two segments meet at a port, one unit apart: keep one point.
      if (q === undefined || Math.hypot(p.x - q[0], p.y - q[1]) > 1.5) {
        pts.push([p.x, p.y]);
      }
    }
  }

  if (cut.flip) {
    pts.reverse();
  }

  const label = laidEdge(edges, cut.mid).labels?.[0];

  return { pts, label: label === undefined ? null : rectOf(label) };
}

export async function elkNested(
  groups: ReadonlyMap<string, Group>,
  parentOf: ReadonlyMap<string, string>,
  leaves: readonly Leaf[],
  edges: readonly LayoutEdge[],
  labelSize: (t: string) => LabelSize,
): Promise<Laid> {
  const graph = new Graph(groups, parentOf, leaves);
  const cuts = edges.map((e, i) => graph.cut(e, i, labelSize));
  const res = await new ELK().layout(graph.root.node);
  const laidEdges = new Map<string, ElkExtendedEdge>();
  const boxes = new Map<string, Rect>();
  collect(res, laidEdges, boxes);

  return {
    w: res.width ?? 0,
    h: res.height ?? 0,
    boxes,
    paths: cuts.map((c) => glue(c, laidEdges)),
  };
}
