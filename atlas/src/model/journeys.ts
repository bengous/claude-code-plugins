import type { Journey, Link, Step } from "./atlas.ts";
import type { Tree } from "./tree.ts";
import { chainOf } from "./tree.ts";
import type { Arrow } from "./view.ts";
import { showsIn } from "./view.ts";

/**
 * Whether `link` is the one a step follows: set directly between its two ends, from its `from` to
 * its `to`, or the other way with `two`. An arrow a view lifts from links between nodes below the
 * step's ends does not count.
 */
export const joins = (link: Link, step: Step): boolean =>
  (link.from === step.from && link.to === step.to) ||
  (link.two === true && link.from === step.to && link.to === step.from);

/** The journey the root declares under `id`, if it has a step; null for any other id. */
export const journeyOf = (tree: Tree, id: string | null): Journey | null =>
  tree.map.root.journeys?.find((journey) => journey.id === id && journey.steps.length > 0) ?? null;

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
