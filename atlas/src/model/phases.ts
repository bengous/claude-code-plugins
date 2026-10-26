import type { Tree } from "./tree.ts";
import { nodeOf } from "./tree.ts";
import type { Arrow } from "./view.ts";

/**
 * What a picked work phase dims: the nodes and the links whose phase comes after it in the
 * Config's phases, and every container all of whose descendants are dimmed. A node or a link
 * without a phase is never dimmed, nor one whose phase the list does not hold, which `atlas check`
 * refuses.
 */
export type Dimmed = {
  readonly nodes: ReadonlySet<string>;
  /** Indexes in the map's links. */
  readonly links: ReadonlySet<number>;
};

const NOTHING: Dimmed = { nodes: new Set(), links: new Set() };

/** What picking `phase`, one of `phases`, dims; null, every phase shown, dims nothing. */
export function dimmedBy(tree: Tree, phases: readonly string[], phase: string | null): Dimmed {
  if (phase === null) {
    return NOTHING;
  }

  const picked = phases.indexOf(phase);

  if (picked === -1) {
    throw new Error(`phase ${phase} is not one of the Config's phases (${phases.join(", ")})`);
  }

  const later = (p: string | undefined): boolean => p !== undefined && phases.indexOf(p) > picked;
  const nodes = new Set<string>();
  // The nodes all of whose descendants are dimmed: every leaf, which has none.
  const settled = new Set<string>();

  // Depth-first order reversed: a node's children come before it.
  for (const id of tree.order.toReversed()) {
    const { phase: own, children } = nodeOf(tree, id);
    const below = (children ?? []).every((c) => nodes.has(c.id) && settled.has(c.id));

    if (below) {
      settled.add(id);
    }

    if (later(own) || (children !== undefined && below)) {
      nodes.add(id);
    }
  }

  return {
    nodes,
    links: new Set(tree.map.links.flatMap((l, i) => (later(l.phase) ? [i] : []))),
  };
}

/** Whether an arrow is dimmed: every link it stands for is. */
export const arrowDimmed = (dimmed: Dimmed, arrow: Arrow): boolean =>
  arrow.links.every((i) => dimmed.links.has(i));
