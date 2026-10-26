// ELK's layered layout of one view whose children are all leaves: every card and ghost a node,
// every arrow an edge, its layers in the map's direction, the rows wrapped to the aspect asked for.
// A view nests nothing it lays out, so the graph is flat; a ghost is held to the first layer when
// the arrows come from it, to the last when they go to it. The view is layered as one graph: laid
// out as separate connected components, each would have a first and a last layer of its own, and a
// held ghost would stand among the cards of the others. The arrows' labels are placed afterwards
// (placement.ts): given to ELK, each widened the gap between two layers by its own width and
// stacked the rows higher, a stub of it almost as much.
// A view with a ranked leaf is partitioned, and its rows do not wrap, as a wrapped row would start
// the ranks over. Every node takes a partition: ELK keeps the partitions in order only when each
// node has one, and reverses an edge that runs against them, which it then refuses on a held
// ghost. So a ghost held to the first layer takes the first partition, each rank the next ones in
// order, a leaf without a rank the one after them, and a ghost held to the last layer the last.
// Traps:
//   - coordinates: without the two ROOT options below, an edge's points are relative to its
//     container;
//   - elk.bundled.js does not start under Bun, where `self` exists: its worker module takes the
//     web worker's branch and exports nothing. layout.spec.ts builds a Layouter of its own from
//     elk-api.js and that branch; a script that lays a view out outside a browser does the same,
//     or runs under Node.
import type { ElkExtendedEdge, ElkNode, LayoutOptions } from "elkjs/lib/elk.bundled.js";
import ELK from "elkjs/lib/elk.bundled.js";

import type { Direction, Side } from "../model/atlas.ts";
import type { Point, Rect, Size } from "./geometry.ts";

export const LAYERED: LayoutOptions = {
  "elk.algorithm": "layered",
  "elk.separateConnectedComponents": "false",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.wrapping.strategy": "MULTI_EDGE",
  "elk.layered.spacing.nodeNodeBetweenLayers": "96",
  "elk.layered.spacing.edgeNodeBetweenLayers": "24",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "14",
  "elk.spacing.nodeNode": "32",
  "elk.spacing.edgeNode": "20",
  "elk.spacing.edgeEdge": "14",
};

const RANKED: LayoutOptions = {
  "elk.partitioning.activate": "true",
  "elk.layered.wrapping.strategy": "OFF",
};

export const ROOT_COORDS: LayoutOptions = {
  "org.eclipse.elk.json.shapeCoords": "ROOT",
  "org.eclipse.elk.json.edgeCoords": "ROOT",
};

/** The layer a node is held to: the first, the last, or wherever its arrows put it. */
export type Edge = "first" | "last" | null;

/** The layer an item's column holds it to: the left column to the first, the right to the last. */
export const edgeOf = (column: Exclude<Side, "both"> | null): Edge =>
  column === "in" ? "first" : column === "out" ? "last" : null;

/** `rank`: its node's, absent when it has none. */
export type Leaf = Size & { readonly id: string; readonly edge: Edge; readonly rank?: number };

/** What lays an ELK graph out: the page's ELK, or one a spec builds. */
export type Layouter = { layout(graph: ElkNode): Promise<ElkNode> };

export type LayoutEdge = { readonly from: string; readonly to: string };

export type Laid = {
  readonly w: number;
  readonly h: number;
  readonly boxes: ReadonlyMap<string, Rect>;
  readonly paths: ReadonlyArray<readonly Point[]>;
};

export function rectOf(n: ElkNode): Rect {
  if (n.x === undefined || n.y === undefined || n.width === undefined || n.height === undefined) {
    throw new Error(`ELK returned ${n.id} without a position or a size`);
  }

  return { x: n.x, y: n.y, w: n.width, h: n.height };
}

const held = (edge: Edge): LayoutOptions =>
  edge === null
    ? {}
    : { "elk.layered.layering.layerConstraint": edge === "first" ? "FIRST" : "LAST" };

/**
 * The partition of each leaf of a ranked view, none in a view without a rank: a ghost held to the
 * first layer, then each rank, then the leaves without one, then a ghost held to the last layer.
 */
function partitionsOf(leaves: readonly Leaf[]): (leaf: Leaf) => LayoutOptions {
  const ranks = leaves.flatMap((l) => (l.rank === undefined ? [] : [l.rank]));

  if (ranks.length === 0) {
    return () => ({});
  }

  const unranked = Math.max(...ranks) + 1;

  const partition = (l: Leaf): number =>
    l.edge === "first" ? 0 : l.edge === "last" ? unranked + 2 : (l.rank ?? unranked) + 1;

  return (l) => ({ "elk.partitioning.partition": String(partition(l)) });
}

function pathOf(edge: ElkExtendedEdge): Point[] {
  const s = edge.sections?.[0];

  if (s === undefined) {
    throw new Error(`ELK returned no route for ${edge.id}`);
  }

  return [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p): Point => [p.x, p.y]);
}

/**
 * The view laid out in `direction`, in rows wrapped to `aspect`, width over height, or by rank in
 * one line when a leaf has a rank.
 */
export async function elkLayered(
  leaves: readonly Leaf[],
  edges: readonly LayoutEdge[],
  aspect: number,
  elk: Layouter = new ELK(),
  direction: Direction = "RIGHT",
): Promise<Laid> {
  const partition = partitionsOf(leaves);

  const flow: LayoutOptions = {
    ...LAYERED,
    ...ROOT_COORDS,
    "elk.direction": direction,
    "elk.aspectRatio": String(aspect),
  };

  const root: ElkNode = {
    id: "root",
    layoutOptions: leaves.some((l) => l.rank !== undefined) ? { ...flow, ...RANKED } : flow,
    children: leaves.map((l) => ({
      id: l.id,
      width: l.w,
      height: l.h,
      layoutOptions: { ...held(l.edge), ...partition(l) },
    })),
    edges: edges.map((e, i): ElkExtendedEdge => ({
      id: `e${i}`,
      sources: [e.from],
      targets: [e.to],
    })),
  };

  const laid = await elk.layout(root);
  const boxes = new Map((laid.children ?? []).map((c): [string, Rect] => [c.id, rectOf(c)]));
  const laidEdges = new Map((laid.edges ?? []).map((e) => [e.id, e]));

  return {
    w: laid.width ?? 0,
    h: laid.height ?? 0,
    boxes,
    paths: edges.map((_, i) => {
      const edge = laidEdges.get(`e${i}`);

      if (edge === undefined) {
        throw new Error(`ELK returned no edge e${i}`);
      }

      return pathOf(edge);
    }),
  };
}
