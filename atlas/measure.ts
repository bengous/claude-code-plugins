import { nestsZone, zone } from "./graph.ts";
import type { Brick } from "./model.ts";
import { el } from "./svg.ts";

// Every box is sized from its text, measured on hidden <text> elements that
// carry the same class as the drawn text. TEXT and TITLE repeat the font
// sizes that plan.fr.html sets on those classes: change one, change the
// other, or text overflows its box.
// Trap: measure outside #map. Inside it, Chrome lays text out at the zoom of
// that moment and rounds the font size there: the same 112-unit label
// measured 70.8 at the zoom of the first layout (before the view is framed)
// and 132.6 at the overview's zoom, so boxes overflowed at random. The
// measuring SVG has no viewBox, so it measures at scale 1, always;
// plan.fr.html sets text-rendering: geometricPrecision on SVG text, which
// keeps drawn text at its measured width at every zoom.
const measSvg = el(
  "svg",
  {
    "aria-hidden": "true",
    width: 10,
    height: 10,
    style: "position: absolute; left: -10000px; top: 0; visibility: hidden",
  },
  document.body,
);

const probes = new Map<string, SVGTextElement>();

export function textWidth(content: string, cls: string): number {
  const probe = probes.get(cls) ?? el("text", { class: cls }, measSvg);
  probes.set(cls, probe);
  probe.textContent = content;

  return probe.getComputedTextLength();
}

export type TextStyle = {
  readonly lbl: string;
  readonly sub: string;
  readonly ls: number;
  readonly ss: number;
  readonly lh: number;
  readonly padX: number;
  readonly padY: number;
};

const BRICK: TextStyle = {
  lbl: "b-lbl",
  sub: "b-sub",
  ls: 15,
  ss: 7.8,
  lh: 9.8,
  padX: 20,
  padY: 15,
};

const EXT: TextStyle = { lbl: "x-lbl", sub: "x-sub", ls: 19, ss: 10, lh: 12.5, padX: 34, padY: 24 };

export const textOf = (n: Brick): TextStyle => (n.zone === null ? EXT : BRICK);

export const subLines = (n: Brick): string[] => (n.sub === "" ? [] : n.sub.split("\n"));

// The height of a card's text block: its label, then its subtitle lines.
export const textHeight = (t: TextStyle, lines: number): number =>
  t.ls + (lines > 0 ? 5 + lines * t.lh : 0);

export type Size = { readonly w: number; readonly h: number };

export function cardSize(n: Brick): Size {
  const t = textOf(n);
  const lines = subLines(n);

  return {
    w: Math.ceil(
      Math.max(textWidth(n.label, t.lbl), ...lines.map((l) => textWidth(l, t.sub))) + t.padX,
    ),
    h: Math.ceil(textHeight(t, lines.length) + t.padY),
  };
}

// Zone titles: the overview uses larger type (k = 1.3) than the detail. The
// titles are uppercase through CSS, so the measure uppercases them too, and
// 1.06 covers their letter-spacing.
export type Level = "dt" | "ov";

export type TitleStyle = {
  readonly big: string;
  readonly title: string;
  readonly tag: string;
  readonly k: number;
};

export const TITLE = {
  dt: { big: "z-big", title: "z-title", tag: "z-tag", k: 1 },
  ov: { big: "ov-big", title: "ov-title", tag: "ov-tag", k: 1.3 },
} satisfies Record<Level, TitleStyle>;

export function titleWidth(zid: string, level: Level): number {
  const z = zone(zid);
  const t = TITLE[level];

  return nestsZone(zid)
    ? textWidth(z.title.toUpperCase(), t.big) * 1.06 + textWidth(z.tag, t.tag) + 70 * t.k
    : Math.max(textWidth(z.title.toUpperCase(), t.title) * 1.06, textWidth(z.tag, t.tag)) +
        32 * t.k;
}

// A fingerprint of the measured fonts: engine.ts lays out again when a font
// that arrives late changes it.
export const fontKey = (): string =>
  [
    "b-lbl",
    "b-sub",
    "x-lbl",
    "z-big",
    "z-title",
    "ov-big",
    "ov-title",
    "ov-chip-t",
    "ov-label",
    "elabel",
  ]
    .map((c) => textWidth("Mg Wq 0123", c).toFixed(1))
    .join(",");
