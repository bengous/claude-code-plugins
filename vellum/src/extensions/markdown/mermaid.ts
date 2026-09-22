import { srgb } from "../../core/page/kit.tsx";

/** Mermaid removes any element carrying the id it renders under: one counter for the whole page, not one per pane. */
let diagrams = 0;

/** A diagram shrinks this far to fit its figure, no further: past it the figure scrolls. */
const SCALE_FLOOR = 0.8;

type Font = { readonly fontFamily: string; readonly fontSize: string };

/** The page's tokens for Mermaid's base theme, resolved to sRGB, the note's included. */
export function themeOf(night: boolean, font: Font) {
  const sheet = srgb("--sheet");
  const tint = srgb("--tint");
  const ink = srgb("--ink");
  const graphite = srgb("--graphite");
  const rule = srgb("--rule");

  return {
    // The base theme derives what is not given here (an ER row, a colour scale) toward light unless told.
    darkMode: night,
    background: sheet,
    mainBkg: tint,
    primaryColor: tint,
    primaryTextColor: ink,
    primaryBorderColor: graphite,
    secondaryColor: sheet,
    tertiaryColor: sheet,
    nodeBorder: graphite,
    lineColor: graphite,
    textColor: ink,
    clusterBkg: sheet,
    clusterBorder: rule,
    edgeLabelBackground: sheet,
    noteBkgColor: tint,
    noteTextColor: ink,
    noteBorderColor: rule,
    titleColor: ink,
    // The base theme's shadow is a grey literal: a halo on the dark sheet.
    dropShadow: "none",
    fontFamily: font.fontFamily,
    fontSize: font.fontSize,
  };
}

/**
 * The narrowest a drawn diagram shrinks to, or `null` for no floor. `baseVal` is typed as a
 * `DOMRect` by `lib.dom.d.ts`, yet #162 reports it `null` in Firefox.
 */
export function minWidthOf(viewBox: {
  readonly baseVal: { readonly width: number } | null;
}): string | null {
  const width = viewBox.baseVal?.width ?? 0;

  return width > 0 ? `${Math.round(width * SCALE_FLOOR)}px` : null;
}

/** Mermaid draws in the page after the mount; its bundle loads on the first diagram only. */
export async function drawDiagrams(root: HTMLElement, night: boolean): Promise<void> {
  const figures = [...root.querySelectorAll<HTMLElement>("figure.mermaid")];
  const [first] = figures;

  if (first === undefined) return;
  const { default: mermaid } = await import("mermaid");
  const { fontFamily, fontSize } = getComputedStyle(first);

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    // A failed render throws before it cleans up: the figure shows the error, and body stays clean.
    suppressErrorRendering: true,
    theme: "base",
    themeVariables: themeOf(night, { fontFamily, fontSize }),
  });

  for (const figure of figures) {
    const source = figure.dataset.source ?? "";
    diagrams += 1;

    try {
      const { svg } = await mermaid.render(`vellum-diagram-${diagrams}`, source);

      if (figure.dataset.source !== source) continue;
      figure.innerHTML = svg;
      const drawn = figure.querySelector("svg");
      const floor = drawn === null ? null : minWidthOf(drawn.viewBox);

      if (drawn !== null && floor !== null) drawn.style.minWidth = floor;
    } catch (cause) {
      const text = document.createElement("pre");
      const failure = document.createElement("p");
      text.textContent = source;
      failure.className = "diagram-error";
      failure.textContent = String(cause);
      figure.replaceChildren(text, failure);
    }
  }
}
