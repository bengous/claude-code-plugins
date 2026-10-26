import type { Node, Pair } from "./atlas.ts";
import type { Tree } from "./tree.ts";
import { childrenOf } from "./tree.ts";

/** A row of the cards: a first element of the `io` pairs, and each column's values for it. */
export type CardRow = {
  readonly key: string;
  /** One cell per column, the values of its pairs with this key, in their order; [] when none. */
  readonly cells: readonly (readonly string[])[];
};

/** A container's leaf children side by side, to compare them field by field. */
export type Cards = {
  /** One per leaf child, in data order. */
  readonly columns: readonly Node[];
  /** The first row: each column's `lead`, or null; no row (null) when no column has one. */
  readonly lead: readonly (string | null)[] | null;
  /** One per distinct first element of the columns' `io` pairs, first seen first. */
  readonly rows: readonly CardRow[];
};

const pairsOf = (node: Node): readonly Pair[] => node.io ?? [];

const leadOf = (node: Node): string | null =>
  node.lead === undefined || node.lead === "" ? null : node.lead;

/**
 * The cards of a container's view (null: the root's), or null when fewer than two of its children
 * are leaves, or none of them has an `io` pair: the page then shows its drawing alone.
 */
export function cardsOf(tree: Tree, container: string | null): Cards | null {
  const columns = childrenOf(tree, container).filter((child) => child.children === undefined);

  if (columns.length < 2 || columns.every((column) => pairsOf(column).length === 0)) {
    return null;
  }

  const keys = new Set(columns.flatMap((column) => pairsOf(column).map(([key]) => key)));
  const lead = columns.map((column) => leadOf(column));

  return {
    columns,
    lead: lead.every((text) => text === null) ? null : lead,
    rows: [...keys].map((key) => ({
      key,
      cells: columns.map((column) =>
        pairsOf(column).flatMap(([first, value]) => (first === key ? [value] : [])),
      ),
    })),
  };
}
