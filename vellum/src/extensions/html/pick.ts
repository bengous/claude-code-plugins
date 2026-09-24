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

function stepSelector(step: Step): string {
  if (step.id !== null && IDENT.test(step.id)) return `${step.tag}#${step.id}`;
  const classes = step.classes.filter((name) => IDENT.test(name)).map((name) => `.${name}`);
  const rank = step.sameTagSiblings > 1 ? `:nth-of-type(${step.nthOfType})` : "";

  return `${step.tag}${classes.join("")}${rank}`;
}

/**
 * The selector of the last step, from the nearest ancestor that carries an id, or from `body`:
 * a chain of child combinators anchored at either matches one element. `steps` is outermost first.
 */
export function selectorOf(steps: readonly Step[]): string {
  const start = steps.findLastIndex((step) => step.id !== null && IDENT.test(step.id));
  const chain = steps.slice(start === -1 ? 0 : start).map((step) => stepSelector(step));

  return (start === -1 ? ["body", ...chain] : chain).join(" > ");
}

/** `tags`: lower-case tag names from the pointer's element up to `html`, innermost first. */
export function targetIndex(tags: readonly string[]): number | null {
  const svg = tags.lastIndexOf("svg");

  if (svg !== -1) return svg;
  const index = tags.findIndex((tag) => tag !== "html" && tag !== "body");

  return index === -1 ? null : index;
}

/** What the wash, the composer and the comment's card call the element; Claude reads its description instead. */
export function labelOf(step: Step): string {
  if (step.id !== null) return `${step.tag}#${step.id}`;
  const first = step.classes[0];

  return first === undefined ? step.tag : `${step.tag}.${first}`;
}
