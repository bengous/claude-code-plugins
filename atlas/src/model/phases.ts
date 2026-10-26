import type { Tree } from "./tree.ts";
import { nodeOf } from "./tree.ts";
import type { Arrow, View } from "./view.ts";
import { labelOf } from "./view.ts";

/**
 * What a picked work phase dims: the nodes and the links whose phase comes after it in the
 * Config's phases. A container's own phase decides for it; a container without one is dimmed once
 * all its descendants are. A link without a phase is dimmed once one of its ends is, and in a view
 * whose arrow for it is drawn to a dimmed box or ghost: a connection does not exist before both its
 * ends do. A leaf without a phase is never dimmed. A phase the list does not hold, which
 * `atlas check` refuses, counts as none.
 */
export type Dimmed = {
  readonly nodes: ReadonlySet<string>;
  /** Indexes in the map's links of those dimmed in every view. */
  readonly links: ReadonlySet<number>;
  /** Indexes in the map's links of those without a phase, dimmed too by the ends an arrow draws. */
  readonly unphased: ReadonlySet<number>;
};

const NOTHING: Dimmed = { nodes: new Set(), links: new Set(), unphased: new Set() };

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

  const { links } = tree.map;

  return {
    nodes,
    links: new Set(
      links.flatMap((l, i) =>
        (listed(l.phase) ? later(l.phase) : nodes.has(l.from) || nodes.has(l.to)) ? [i] : [],
      ),
    ),
    unphased: new Set(links.flatMap((l, i) => (listed(l.phase) ? [] : [i]))),
  };
}

const linkDimmed = (dimmed: Dimmed, arrow: Arrow, i: number): boolean =>
  dimmed.links.has(i) ||
  (dimmed.unphased.has(i) && (dimmed.nodes.has(arrow.from) || dimmed.nodes.has(arrow.to)));

/** Whether an arrow is dimmed: every link it stands for is, in its view. */
export const arrowDimmed = (dimmed: Dimmed, arrow: Arrow): boolean =>
  arrow.links.every((i) => linkDimmed(dimmed, arrow, i));

/** Whether a view draws something dimmed: a box, a chip, a ghost or an arrow; its legend's "later". */
export const dimsIn = (dimmed: Dimmed, view: View): boolean =>
  view.boxes.some(
    (b) =>
      dimmed.nodes.has(b.id) ||
      (b.kind === "container" && b.chips.some((c) => dimmed.nodes.has(c.id))),
  ) ||
  view.ghosts.some((g) => dimmed.nodes.has(g.id)) ||
  view.arrows.some((a) => arrowDimmed(dimmed, a));

/**
 * An arrow's label at the phase picked: read from the links it stands for that are not dimmed,
 * as its own is read from all of them; its own while every link or none is dimmed.
 */
export function labelAt(tree: Tree, dimmed: Dimmed, arrow: Arrow): string {
  const shown = arrow.links.filter((i) => !linkDimmed(dimmed, arrow, i));

  if (shown.length === 0 || shown.length === arrow.links.length) {
    return arrow.label;
  }

  return labelOf(
    tree,
    shown.flatMap((i) => tree.map.links[i] ?? []),
    arrow.two,
  );
}
