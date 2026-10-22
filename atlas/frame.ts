import type { Graph } from "./graph.ts";
import type { Rect } from "./machine.ts";
import type { Level } from "./measure.ts";
import { TITLE, textWidth } from "./measure.ts";
import type { Zone } from "./model.ts";
import { el, onActivate, openBadge, text } from "./svg.ts";

function zoneKind(graph: Graph, z: Zone): string {
  if (z.ext === true) {
    return "ext";
  }

  if (!graph.nestsZone(z.id)) {
    return "module";
  }

  return z.parent === undefined ? "outer" : "inner";
}

export function drawZone(
  graph: Graph,
  layer: SVGGElement,
  zid: string,
  r: Rect,
  level: Level,
  onPick: (zid: string) => void,
): SVGGElement {
  const z = graph.zone(zid);
  const t = TITLE[level];
  const k = t.k;
  const kind = zoneKind(graph, z);
  const g = el("g", { class: `zone ${kind}`, style: `--zc: var(${z.color})` }, layer);
  el(
    "rect",
    { x: r.x, y: r.y, width: r.w, height: r.h, rx: kind === "outer" ? 16 : 10, class: "zone-bg" },
    g,
  );

  if (graph.nestsZone(zid)) {
    text(g, { x: r.x + 22 * k, y: r.y + 40 * k, class: t.big }, z.title);
    const tagX = r.x + 34 * k + textWidth(z.title.toUpperCase(), t.big) * 1.06;
    text(g, { x: tagX, y: r.y + 38 * k, class: t.tag }, z.tag);
  } else {
    text(g, { x: r.x + 16 * k, y: r.y + 31 * k, class: t.title }, z.title);
    text(g, { x: r.x + 16 * k, y: r.y + 48 * k, class: t.tag }, z.tag);
  }

  openBadge(g, z.info, r.x + r.w - 16 * k, r.y + 16 * k, 6 * k);
  onActivate(g, `Zone ${z.title}`, () => {
    onPick(zid);
  });

  return g;
}
