import type { Box } from "../shared/wire.ts";

/** One element of a chain, as a selector needs it: its tag, its id, its classes, its rank among same-tag siblings. */
export type Step = {
  readonly tag: string;
  readonly id: string | null;
  readonly classes: readonly string[];
  readonly nthOfType: number;
  readonly sameTagSiblings: number;
};

/** A name a selector can carry unescaped; anything else would make the selector unusable. */
const IDENT = /^-?[a-z_][\w-]*$/iu;

/** A zone covers an element when at least this share of the element's box lies in it. */
const COVERED = 0.5;

function stepSelector(step: Step): string {
  if (step.id !== null && IDENT.test(step.id)) return `${step.tag}#${step.id}`;
  const classes = step.classes.filter((name) => IDENT.test(name)).map((name) => `.${name}`);
  const rank = step.sameTagSiblings > 1 ? `:nth-of-type(${step.nthOfType})` : "";

  return `${step.tag}${classes.join("")}${rank}`;
}

/**
 * The selector of the last step, from the nearest ancestor that carries an id, or from `body`:
 * a chain of child combinators anchored at either matches one element. `steps` is outermost
 * first. Adapted from vellum's `src/formats/html/pick.ts`.
 */
export function selectorOf(steps: readonly Step[]): string {
  const start = steps.findLastIndex((step) => step.id !== null && IDENT.test(step.id));
  const chain = steps.slice(start === -1 ? 0 : start).map((step) => stepSelector(step));

  return (start === -1 ? ["body", ...chain] : chain).join(" > ");
}

/** What the overlay calls an element on screen; Claude reads its whole description instead. */
export function labelOf(step: Step): string {
  if (step.id !== null) return `${step.tag}#${step.id}`;
  const first = step.classes[0];

  return first === undefined ? step.tag : `${step.tag}.${first}`;
}

/**
 * Which element of a chain a point picks. `tags`: lower-case tag names from the pointer's element
 * up to `html`, innermost first. Inside an SVG, the outermost `svg`: its shapes say nothing alone.
 */
export function targetIndex(tags: readonly string[]): number | null {
  const svg = tags.lastIndexOf("svg");

  if (svg !== -1) return svg;
  const index = tags.findIndex((tag) => tag !== "html" && tag !== "body");

  return index === -1 ? null : index;
}

/** How far the page is scrolled, in CSS pixels. */
export type Scroll = { readonly x: number; readonly y: number };

/** A box the viewport draws, in page pixels: from the document's top-left corner, the page scrolled by `scroll`. */
export function pageBox(box: Box, scroll: Scroll): Box {
  return { ...box, x: box.x + scroll.x, y: box.y + scroll.y };
}

/** Where the viewport draws a box in page pixels, the page scrolled by `scroll`. */
export function viewportBox(box: Box, scroll: Scroll): Box {
  return { ...box, x: box.x - scroll.x, y: box.y - scroll.y };
}

/** The main button pressed while pointing: where, and whether Ctrl (⌘) adds to the selection. */
export type Press = { readonly x: number; readonly y: number; readonly adding: boolean };

/** A pointer event while pointing, as a press reads it; `inside`: over the overlay's panel or composer. */
export type PointerInput = {
  readonly type: string;
  readonly inside: boolean;
  readonly button: number;
  readonly x: number;
  readonly y: number;
  readonly adding: boolean;
};

/** The press after a pointer event, and the press that event picks from, `null` for none. */
export type PressStep = { readonly press: Press | null; readonly picks: Press | null };

/**
 * What a pointer event does to the press: the main button down outside the overlay starts one; a
 * release or a cancel anywhere ends it, and only a release outside the overlay picks.
 */
export function pressAfter(press: Press | null, input: PointerInput): PressStep {
  switch (input.type) {
    case "pointerdown":
      return {
        press:
          input.inside || input.button !== 0
            ? press
            : { x: input.x, y: input.y, adding: input.adding },
        picks: null,
      };
    case "pointerup":
      return { press: null, picks: input.inside ? null : press };
    case "pointercancel":
      return { press: null, picks: null };
    default:
      return { press, picks: null };
  }
}

export function boxBetween(
  a: { readonly x: number; readonly y: number },
  b: { readonly x: number; readonly y: number },
): Box {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/** Whether `zone` covers at least half of `box`; an empty box is covered by nothing. */
export function covers(zone: Box, box: Box): boolean {
  const width = Math.min(box.x + box.width, zone.x + zone.width) - Math.max(box.x, zone.x);
  const height = Math.min(box.y + box.height, zone.y + zone.height) - Math.max(box.y, zone.y);
  const area = box.width * box.height;

  return area > 0 && width > 0 && height > 0 && width * height >= area * COVERED;
}

/**
 * The outermost of `nodes`: those with no ancestor among them. `parentOf` answers each node's
 * parent; the order of `nodes` is kept.
 */
export function outermost<T>(nodes: readonly T[], parentOf: (node: T) => T | null): T[] {
  const set = new Set(nodes);

  return nodes.filter((node) => {
    for (let at = parentOf(node); at !== null; at = parentOf(at)) {
      if (set.has(at)) return false;
    }

    return true;
  });
}
