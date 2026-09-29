import type { Panel } from "../extension.ts";

export const DOCS_PANE = "docs";

/** Left to right. The one place the order is written until settings exist. */
export const PANE_ORDER: readonly string[] = [DOCS_PANE];

export type Pane =
  | { readonly kind: "docs" }
  | { readonly kind: "panel"; readonly id: string; readonly panel: Panel };

/** A panel whose `shown()` holds, under its extension's id. */
export type ShownPanel = { readonly id: string; readonly panel: Panel };

/** Drops duplicates and unknown ids; `docs` exactly once; a shown panel the order omits comes after, in registry order. */
export function panesOf(order: readonly string[], shown: readonly ShownPanel[]): readonly Pane[] {
  const panels = new Map(shown.map(({ id, panel }) => [id, panel]));
  const known = [...new Set(order)].filter((id) => id === DOCS_PANE || panels.has(id));
  const placed = known.includes(DOCS_PANE) ? known : [DOCS_PANE, ...known];
  const omitted = shown.flatMap(({ id }) => (placed.includes(id) ? [] : [id]));

  return [...placed, ...omitted].flatMap((id): Pane[] => {
    if (id === DOCS_PANE) return [{ kind: "docs" }];
    const panel = panels.get(id);

    return panel === undefined ? [] : [{ kind: "panel", id, panel }];
  });
}

/** The sides of a pane that keep a gutter for a handle. */
export type Gutters = { readonly start: boolean; readonly end: boolean };

/** The rail's handle sits left of the first pane and the comments' right of the last, whichever pane is there. */
export function guttersOf(index: number, count: number): Gutters {
  return { start: index === 0, end: index === count - 1 };
}
