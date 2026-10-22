import type { Size } from "./geometry.ts";
import { el } from "./svg.ts";

// Every box is sized from its text, measured on hidden <text> elements that carry the same class
// as the drawn text. The sizes below repeat the font sizes atlas.html sets on those classes:
// change one, change the other, or text overflows its box.
// Trap: measure outside #map. Inside it, Chrome lays text out at the zoom of that moment and rounds
// the font size there: the same 112-unit label measured 70.8 at the zoom of the first layout and
// 132.6 at the root view's zoom, so boxes overflowed at random. The measuring SVG has no viewBox,
// so it measures at scale 1, always; atlas.html sets text-rendering: geometricPrecision on SVG
// text, which keeps drawn text at its measured width at every zoom.
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

/** A leaf's card: its label, then its subtitle lines. */
export const CARD = {
  lbl: "card-lbl",
  sub: "card-sub",
  ls: 20,
  ss: 11,
  lh: 14,
  padX: 24,
  padY: 16,
};

/** A child named inside a container's box. */
export const CHIP = { cls: "chip-t", h: 34, gap: 9, pad: 13, maxW: 560 };

/** A container's box: its title and tag above its chips. Titles are uppercase through CSS, so the
 * measure uppercases them too, and 1.06 covers their letter-spacing. */
export const BOX = { title: "box-title", tag: "box-tag", padX: 20, top: 80, bottom: 20 };

/** A ghost's pill. */
export const GHOST = { cls: "ghost-t", h: 52, pad: 22 };

/** An arrow's label. */
export const LABEL = { cls: "flow-label", h: 17, pad: 8 };

export const subLines = (sub: string): string[] => (sub === "" ? [] : sub.split("\n"));

export const textHeight = (lines: number): number =>
  CARD.ls + (lines > 0 ? 5 + lines * CARD.lh : 0);

export function cardSize(label: string, sub: string): Size {
  const lines = subLines(sub);

  return {
    w: Math.ceil(
      Math.max(textWidth(label, CARD.lbl), ...lines.map((l) => textWidth(l, CARD.sub))) + CARD.padX,
    ),
    h: Math.ceil(textHeight(lines.length) + CARD.padY),
  };
}

export const tagOf = (sub: string): string => sub.replaceAll("\n", " · ");

export const titleWidth = (label: string, sub: string): number =>
  Math.max(textWidth(label.toUpperCase(), BOX.title) * 1.06, textWidth(tagOf(sub), BOX.tag)) + 32;

export const labelSize = (label: string): Size => ({
  w: Math.ceil(textWidth(label, LABEL.cls)) + LABEL.pad,
  h: LABEL.h,
});

// A fingerprint of the measured fonts: engine.ts lays out again when a font that arrives late
// changes it.
export const fontKey = (): string =>
  [CARD.lbl, CARD.sub, CHIP.cls, BOX.title, BOX.tag, GHOST.cls, LABEL.cls]
    .map((c) => textWidth("Mg Wq 0123", c).toFixed(1))
    .join(",");
