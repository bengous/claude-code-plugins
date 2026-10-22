// ELK's layered layout of one view whose children are all leaves: every card and ghost a node,
// every arrow an edge with its label, left to right. A view nests nothing it lays out, so the
// graph is flat.
// Traps:
//   - coordinates: without the two ROOT options below, an edge's points are relative to its
//     container;
//   - labels need a width and a height: ELK then keeps room for them;
//   - elk.bundled.js does not start under Bun (Bun's global Worker sends it down the wrong path);
//     a script that lays a view out outside a browser must run under Node.
import type { ElkExtendedEdge, ElkLabel, ElkNode, LayoutOptions } from "elkjs/lib/elk.bundled.js";
import ELK from "elkjs/lib/elk.bundled.js";

import type { Point, Rect, Size } from "./geometry.ts";

export const LAYERED: LayoutOptions = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.spacing.nodeNodeBetweenLayers": "64",
  "elk.layered.spacing.edgeNodeBetweenLayers": "24",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "14",
  "elk.spacing.nodeNode": "32",
  "elk.spacing.edgeNode": "20",
  "elk.spacing.edgeEdge": "14",
  "elk.spacing.edgeLabel": "4",
  "elk.edgeLabels.placement": "CENTER",
};

export const ROOT_COORDS: LayoutOptions = {
  "org.eclipse.elk.json.shapeCoords": "ROOT",
  "org.eclipse.elk.json.edgeCoords": "ROOT",
};

export type Leaf = Size & { readonly id: string };

/** `flip` lays the arrow out reversed and draws it the right way round. */
export type LayoutEdge = {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly flip: boolean;
};

export type LaidPath = { readonly pts: Point[]; readonly label: Rect | null };

export type Laid = {
  readonly w: number;
  readonly h: number;
  readonly boxes: ReadonlyMap<string, Rect>;
  readonly paths: readonly LaidPath[];
};

export function rectOf(n: ElkNode | ElkLabel): Rect {
  if (n.x === undefined || n.y === undefined || n.width === undefined || n.height === undefined) {
    throw new Error(`ELK returned ${n.id ?? "a box"} without a position or a size`);
  }

  return { x: n.x, y: n.y, w: n.width, h: n.height };
}

function pathOf(edge: ElkExtendedEdge, flip: boolean): LaidPath {
  const s = edge.sections?.[0];

  if (s === undefined) {
    throw new Error(`ELK returned no route for ${edge.id}`);
  }

  const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p): Point => [p.x, p.y]);

  if (flip) {
    pts.reverse();
  }

  const label = edge.labels?.[0];

  return { pts, label: label === undefined ? null : rectOf(label) };
}

export async function elkLayered(
  leaves: readonly Leaf[],
  edges: readonly LayoutEdge[],
  labelSize: (label: string) => Size,
): Promise<Laid> {
  const root: ElkNode = {
    id: "root",
    layoutOptions: { ...LAYERED, ...ROOT_COORDS },
    children: leaves.map((l) => ({ id: l.id, width: l.w, height: l.h })),
    edges: edges.map((e, i): ElkExtendedEdge => {
      const [from, to] = e.flip ? [e.to, e.from] : [e.from, e.to];
      const size = labelSize(e.label);

      return {
        id: `e${i}`,
        sources: [from],
        targets: [to],
        labels: e.label === "" ? [] : [{ text: e.label, width: size.w, height: size.h }],
      };
    }),
  };

  const laid = await new ELK().layout(root);
  const boxes = new Map((laid.children ?? []).map((c): [string, Rect] => [c.id, rectOf(c)]));
  const laidEdges = new Map((laid.edges ?? []).map((e) => [e.id, e]));

  return {
    w: laid.width ?? 0,
    h: laid.height ?? 0,
    boxes,
    paths: edges.map((e, i) => {
      const edge = laidEdges.get(`e${i}`);

      if (edge === undefined) {
        throw new Error(`ELK returned no edge e${i}`);
      }

      return pathOf(edge, e.flip);
    }),
  };
}
