import type { Journey, Link, Section, Step } from "./atlas.ts";
import type { Tree } from "./tree.ts";
import { chainOf, isLeaf, itemIn, liftIn } from "./tree.ts";
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
 * Whether the view of `container` draws `id`: as a child, a box or a card; as a ghost (showsIn);
 * or as a chip, a child of one of its container children.
 */
export function drawnIn(tree: Tree, container: string | null, id: string): boolean {
  if (showsIn(tree, container, id)) {
    return true;
  }

  const child = tree.nodes.has(id) ? liftIn(tree, container, id) : null;

  return child !== null && chainOf(tree, id).at(-2) === child;
}

/**
 * What stands for `id` in the view of `container`: what draws it there (drawnIn), else the box or
 * ghost of that view that holds it (itemIn); null when the view has neither.
 */
export function representativeIn(tree: Tree, container: string | null, id: string): string | null {
  if (drawnIn(tree, container, id)) {
    return id;
  }

  const item = tree.nodes.has(id) ? itemIn(tree, container, id) : null;

  return item !== null && showsIn(tree, container, item) ? item : null;
}

/** The root, then every container, depth-first. */
const viewsOf = (tree: Tree): readonly (string | null)[] => [
  null,
  ...tree.order.filter((id) => !isLeaf(tree, id)),
];

const depthOf = (tree: Tree, container: string | null): number =>
  container === null ? 0 : chainOf(tree, container).length;

/** The deepest of the views, the first depth-first among the deepest; undefined for none. */
const deepestOf = (tree: Tree, views: readonly (string | null)[]): string | null | undefined =>
  views.reduce<string | null | undefined>(
    (best, view) => (best === undefined || depthOf(tree, view) > depthOf(tree, best) ? view : best),
    undefined,
  );

const drawsBoth = (tree: Tree, container: string | null, step: Step): boolean =>
  drawnIn(tree, container, step.from) && drawnIn(tree, container, step.to);

/**
 * The view a journey is played in: the deepest of the root's and the containers' that draws every
 * end of every step (drawnIn), the first depth-first among the deepest; the root's when none does.
 */
export function hostView(tree: Tree, journey: Journey): string | null {
  const ends = stepsOf(journey).flatMap(({ step }) => [step.from, step.to]);
  const hosts = viewsOf(tree).filter((view) => ends.every((end) => drawnIn(tree, view, end)));

  return deepestOf(tree, hosts) ?? null;
}

/**
 * The view a journey's step is played in: the journey's host view when it draws both its ends;
 * else the deepest view that draws both, the first depth-first among the deepest; else the view
 * it opens on its own (stepView), which, no view drawing both, is their lowest common
 * container's. `host` is the journey's (hostView).
 */
export function playView(tree: Tree, host: string | null, step: Step): string | null {
  if (drawsBoth(tree, host, step)) {
    return host;
  }

  const views = viewsOf(tree).filter((view) => drawsBoth(tree, view, step));
  const deepest = deepestOf(tree, views);

  return deepest === undefined ? stepView(tree, step) : deepest;
}

/** A step traced in a view: between the representatives of its ends there, two distinct ones. */
export type Traced = { readonly at: Numbered; readonly from: string; readonly to: string };

/**
 * The steps of section `s` (from 1) the view of `container` traces, in order: each whose two ends
 * have representatives there (representativeIn), distinct ones; a step whose ends share one, or
 * with an end that has none, is not traced.
 */
export const tracedIn = (
  tree: Tree,
  container: string | null,
  journey: Journey,
  s: number,
): readonly Traced[] =>
  stepsOf(journey).flatMap((at): Traced[] => {
    const from = representativeIn(tree, container, at.step.from);
    const to = representativeIn(tree, container, at.step.to);

    return at.s === s && from !== null && to !== null && from !== to ? [{ at, from, to }] : [];
  });

/**
 * The form the data has as step `n` starts: the form after the step before it (formAfter) when
 * that step is in the same section; null for the first step of a section.
 */
export function formBefore(journey: Journey, n: number): string | null {
  const steps = stepsOf(journey);

  return n > 1 && steps[n - 2]?.s === steps[n - 1]?.s ? formAfter(journey, n - 1) : null;
}
