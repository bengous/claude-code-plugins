export type HighlightName = "vellum-comment" | "vellum-draft" | "vellum-focus";

/** The page holds one entry per name, shared by the panes: each pane's share of it, by name. */
const shares = new Map<HighlightName, Map<Element, readonly Range[]>>();

/**
 * Paints `ranges` under `name` for `pane` with the CSS Custom Highlight API, beside what the other
 * panes painted under it; an empty list clears the pane's share, and the name once no pane holds one.
 */
export function paint(pane: Element, name: HighlightName, ranges: readonly Range[]): void {
  const panes = shares.get(name) ?? new Map<Element, readonly Range[]>();

  if (ranges.length === 0) panes.delete(pane);
  else panes.set(pane, ranges);
  shares.set(name, panes);
  const all = [...panes.values()].flat();

  if (all.length === 0) {
    CSS.highlights.delete(name);

    return;
  }

  CSS.highlights.set(name, new Highlight(...all));
}
