import type { Point } from "./machine.ts";
import type { Info } from "./model.ts";

const NS = "http://www.w3.org/2000/svg";

export type Attrs = Readonly<Record<string, string | number>>;

export function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs,
  parent: Element | null,
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);

  for (const [k, v] of Object.entries(attrs)) {
    e.setAttribute(k, String(v));
  }

  parent?.append(e);

  return e;
}

export function text(tag: SVGElement, attrs: Attrs, content: string): SVGTextElement {
  const t = el("text", attrs, tag);
  t.textContent = content;

  return t;
}

export const esc = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const fmt = ([x, y]: Point): string => `${x.toFixed(1)} ${y.toFixed(1)}`;

// Polyline with its corners rounded to radius r.
export function rounded(pts: readonly Point[], r: number): string {
  const first = pts[0];
  const last = pts.at(-1);

  if (first === undefined || last === undefined) {
    throw new Error("rounded: an empty polyline");
  }

  let d = `M${fmt(first)}`;

  for (let i = 1; i < pts.length - 1; i += 1) {
    const [p0, p1, p2] = [pts[i - 1], pts[i], pts[i + 1]];

    if (p0 === undefined || p1 === undefined || p2 === undefined) {
      continue;
    }

    const l1 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const l2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);

    if (l1 < 0.5 || l2 < 0.5) {
      continue;
    }

    const k1 = Math.min(r, l1 / 2) / l1;
    const k2 = Math.min(r, l2 / 2) / l2;
    const a: Point = [p1[0] - (p1[0] - p0[0]) * k1, p1[1] - (p1[1] - p0[1]) * k1];
    const b: Point = [p1[0] + (p2[0] - p1[0]) * k2, p1[1] + (p2[1] - p1[1]) * k2];
    d += ` L${fmt(a)} Q${fmt(p1)} ${fmt(b)}`;
  }

  return `${d} L${fmt(last)}`;
}

// The badge of a zone or brick that carries open points, centered on (x, y).
export function openBadge(g: SVGGElement, info: Info, x: number, y: number, r: number): void {
  if ((info.open?.length ?? 0) > 0) {
    el("circle", { cx: x, cy: y, r, class: "open-dot" }, g);
  }
}

// Click and keyboard activation.
export function onActivate(g: SVGGElement, label: string, fn: () => void): void {
  g.setAttribute("tabindex", "0");
  g.setAttribute("role", "button");
  g.setAttribute("aria-label", label);
  g.classList.add("hit");
  g.addEventListener("click", (e) => {
    e.stopPropagation();
    fn();
  });
  g.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  });
}

// The background grid and the three arrowheads (plain, refused, lit).
export function defs(svg: SVGSVGElement): void {
  const d = el("defs", {}, svg);

  const pat = el(
    "pattern",
    { id: "grid", width: 100, height: 100, patternUnits: "userSpaceOnUse" },
    d,
  );

  for (let i = 0; i < 100; i += 20) {
    const width = i === 0 ? 1.2 : 0.6;
    el("line", { x1: i, y1: 0, x2: i, y2: 100, stroke: "var(--grid)", "stroke-width": width }, pat);
    el("line", { x1: 0, y1: i, x2: 100, y2: i, stroke: "var(--grid)", "stroke-width": width }, pat);
  }

  for (const [id, cls] of [
    ["arr", ""],
    ["arr-deny", "deny"],
    ["arr-hot", "hot"],
  ] as const) {
    const m = el(
      "marker",
      {
        id,
        viewBox: "0 0 10 10",
        refX: 8.5,
        refY: 5,
        markerWidth: 5.5,
        markerHeight: 5.5,
        orient: "auto-start-reverse",
        markerUnits: "strokeWidth",
      },
      d,
    );

    el("path", { d: "M0,0 L10,5 L0,10 z", class: `arrowhead ${cls}` }, m);
  }
}

export const markerOf = (kind: string | undefined): string =>
  kind === "deny" ? "url(#arr-deny)" : "url(#arr)";

// What render() toggles: the drawn groups of each zone or brick, and each
// drawn arrow with the bricks it joins.
export type Registry = Map<string, SVGGElement[]>;

// from, to: the boxes the arrow joins (a brick, or on the overview a zone or
// an outside service). bricks: every brick at an end of the brick arrows it
// stands for, so selecting or hovering any of them lights it.
export type ArrowEl = {
  readonly from: string;
  readonly to: string;
  readonly bricks: readonly string[];
  readonly g: SVGGElement;
  readonly path: SVGPathElement;
  readonly marker: string;
  readonly two: boolean;
};

export function register(map: Registry, id: string, g: SVGGElement): void {
  const list = map.get(id) ?? [];
  list.push(g);
  map.set(id, list);
}

// An arrow's path with its arrowheads.
export function arrowPath(
  g: SVGGElement,
  d: string,
  kind: string | undefined,
  two: boolean,
): SVGPathElement {
  const path = el("path", { d }, g);
  const m = markerOf(kind);
  path.setAttribute("marker-end", m);

  if (two) {
    path.setAttribute("marker-start", m);
  }

  return path;
}
