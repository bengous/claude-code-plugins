import type { LegendKey } from "./atlas.ts";
import { flowsOf } from "./flows.ts";
import type { Graph } from "./graph.ts";
import { esc } from "./svg.ts";
import { openItems } from "./threads.ts";

const ORDER: readonly LegendKey[] = ["flow", "dash", "deny", "coupled", "outside", "open"];

const line = (stroke: string, dash = ""): string =>
  `<svg viewBox="0 0 26 8" aria-hidden="true"><line x1="0" y1="4" x2="26" y2="4" stroke="${stroke}" stroke-width="2"${dash}/></svg>`;

const mark = (figure: string): string =>
  `<svg viewBox="0 0 26 12" aria-hidden="true" style="height:12px">${figure}</svg>`;

const GLYPH: Readonly<Record<LegendKey, string>> = {
  flow: line("var(--ink-3)"),
  dash: line("var(--ink-3)", ` stroke-dasharray="5 4"`),
  deny: line("var(--deny)"),
  coupled: mark(
    `<rect x="1" y="1" width="24" height="10" rx="2" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="3 2"/>`,
  ),
  outside: mark(
    `<rect x="1" y="1" width="24" height="10" rx="5" fill="none" stroke="var(--ink-3)" stroke-width="1.5" stroke-dasharray="4 3"/>`,
  ),
  open: mark(`<circle cx="13" cy="6" r="4.5" fill="var(--open)"/>`),
};

// The legend's lines the map draws, in legend order: a line for a kind the map never uses would
// explain nothing on it. The detail draws each leaves' arrow with its own kind; the overview
// draws plain an arrow whose leaves' arrows differ in kind.
export function legendKeys(graph: Graph): LegendKey[] {
  const { plan, links } = graph;

  const used: Readonly<Record<LegendKey, boolean>> = {
    flow: links.some((e) => e.kind === undefined) || flowsOf(graph).some((f) => f.kind === ""),
    dash: links.some((e) => e.kind === "dash"),
    deny: links.some((e) => e.kind === "deny"),
    coupled: plan.nodes.some((n) => n.couples.length > 0),
    outside: plan.zones.some((z) => z.ext === true) || plan.nodes.some((n) => n.zone === null),
    open: openItems(plan).length > 0,
  };

  return ORDER.filter((key) => used[key]);
}

export const legendHtml = (
  keys: readonly LegendKey[],
  labels: Readonly<Record<LegendKey, string>>,
): string => keys.map((key) => `<span>${GLYPH[key]}${esc(labels[key])}</span>`).join("");
