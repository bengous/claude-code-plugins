import type { Link, Step } from "./atlas.ts";

/**
 * Whether `link` is the one a step follows: set directly between its two ends, from its `from` to
 * its `to`, or the other way with `two`. An arrow a view lifts from links between nodes below the
 * step's ends does not count.
 */
export const joins = (link: Link, step: Step): boolean =>
  (link.from === step.from && link.to === step.to) ||
  (link.two === true && link.from === step.to && link.to === step.from);
