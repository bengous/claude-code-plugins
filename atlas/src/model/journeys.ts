import type { Journey, Link, Section, Step } from "./atlas.ts";
import type { Tree } from "./tree.ts";
import { chainOf } from "./tree.ts";
import type { Arrow } from "./view.ts";
import { showsIn } from "./view.ts";

/**
 * Whether `link` is the one a step follows: set directly between its two ends, from its `from` to
 * its `to`, or the other way with `two`; for a step with `back`, set from its `to` to its `from`.
 * An arrow a view lifts from links between nodes below the step's ends does not count.
 */
export const joins = (link: Link, step: Step): boolean =>
  step.back === true
    ? link.from === step.to && link.to === step.from
    : (link.from === step.from && link.to === step.to) ||
      (link.two === true && link.from === step.to && link.to === step.from);

/** A step that carries `trigger` and `kind`: an entry of its journey, what sets it off. */
export type EntryStep = Extract<Step, { readonly trigger: string }>;

export const isEntry = (step: Step): step is EntryStep =>
  step.trigger !== undefined && step.kind !== undefined;

/**
 * The nodes a section has reached before its step at `index`, from 0: the ends of the steps before
 * it in that section, none from another.
 */
export const reachedBefore = (section: Section, index: number): ReadonlySet<string> =>
  new Set(section.steps.slice(0, index).flatMap((step) => [step.from, step.to]));

/** A step with its number, from 1 across the sections, and its section's, from 1. */
export type Numbered = {
  readonly n: number;
  readonly step: Step;
  readonly s: number;
  readonly section: Section;
};

/** A journey's steps in order, numbered across its sections. */
export const stepsOf = (journey: Journey): readonly Numbered[] =>
  journey.sections
    .flatMap((section, i) => section.steps.map((step) => ({ step, s: i + 1, section })))
    .map((numbered, i) => ({ ...numbered, n: i + 1 }));

/**
 * The form the data has once step `n` is done: the `carries` of the last step that has one, from
 * the start of step n's section to step n; null when none has, or past the journey's last step.
 */
export function formAfter(journey: Journey, n: number): string | null {
  const steps = stepsOf(journey);
  const s = steps[n - 1]?.s;

  return (
    steps.findLast((at) => at.s === s && at.n <= n && at.step.carries !== undefined)?.step
      .carries ?? null
  );
}

/** The journey the root declares under `id`, if it has a step; null for any other id. */
export const journeyOf = (tree: Tree, id: string | null): Journey | null =>
  tree.map.root.journeys?.find((journey) => journey.id === id && stepsOf(journey).length > 0) ??
  null;

const ancestorsOf = (tree: Tree, id: string): readonly string[] => chainOf(tree, id).slice(0, -1);

/** The deepest container that holds both, neither of them; null for the root. */
function commonOf(tree: Tree, a: string, b: string): string | null {
  const above = ancestorsOf(tree, a);
  const other = ancestorsOf(tree, b);
  const split = above.findIndex((id, i) => other[i] !== id);

  return (split === -1 ? above : above.slice(0, split)).at(-1) ?? null;
}

/**
 * The container whose view a step opens, null for the root's: the deepest view that shows both of
 * its ends, as boxes, cards or ghosts (showsIn), and draws its arrow, which needs one end at
 * least to be a child of that container. That is the deeper end's parent, or the other end's when
 * the deeper end does not show there. When no view does, each end standing in its own branch below
 * their lowest common container, it is that container's view: the step's arrow is the one lifted
 * between the two boxes that hold its ends, whose chips name them, or the nodes that hold them.
 */
export function stepView(tree: Tree, step: Step): string | null {
  const depth = (id: string): number => chainOf(tree, id).length;
  const ends = [step.from, step.to].toSorted((a, b) => depth(b) - depth(a));

  for (const end of ends) {
    const parent = ancestorsOf(tree, end).at(-1) ?? null;

    if (showsIn(tree, parent, step.from) && showsIn(tree, parent, step.to)) {
      return parent;
    }
  }

  return commonOf(tree, step.from, step.to);
}

/**
 * Whether a step lights the arrow: the arrow stands for a link the step follows (joins), drawn
 * between its ends or lifted to the boxes that hold them.
 */
export const stepLights = (tree: Tree, arrow: Arrow, step: Step): boolean =>
  arrow.links.some((index) => {
    const link = tree.map.links[index];

    return link !== undefined && joins(link, step);
  });
