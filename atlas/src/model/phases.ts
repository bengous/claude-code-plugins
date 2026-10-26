import type { Tree } from "./tree.ts";
import { chainOf, nodeOf } from "./tree.ts";
import type { Arrow } from "./view.ts";

/**
 * What a picked work phase dims: the nodes and the links whose phase comes after it in the
 * Config's phases. A container's own phase decides for it; a container without one is dimmed once
 * all its descendants are. A link without a phase is dimmed once one of its ends is, or a
 * container holding that end: a connection does not exist before both its ends do. A leaf without
 * a phase is never dimmed. A phase the list does not hold, which `atlas check` refuses, counts as
 * none.
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

  const listed = (p: string | undefined): p is string => p !== undefined && phases.includes(p);
  const later = (p: string): boolean => phases.indexOf(p) > picked;
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

    if (listed(own) ? later(own) : children !== undefined && below) {
      nodes.add(id);
    }
  }

  const gone = (end: string): boolean => chainOf(tree, end).some((id) => nodes.has(id));

  return {
    nodes,
    links: new Set(
      tree.map.links.flatMap((l, i) =>
        (listed(l.phase) ? later(l.phase) : gone(l.from) || gone(l.to)) ? [i] : [],
      ),
    ),
  };
}

/** Whether an arrow is dimmed: every link it stands for is. */
export const arrowDimmed = (dimmed: Dimmed, arrow: Arrow): boolean =>
  arrow.links.every((i) => dimmed.links.has(i));
