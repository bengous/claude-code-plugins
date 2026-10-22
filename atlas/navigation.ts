import type { Tree } from "./tree.ts";
import { chainOf, childrenOf, nodeOf } from "./tree.ts";
import { viewOf } from "./view.ts";

/**
 * Where the reader stands: the containers from a child of the root down to the open one (empty:
 * the root's view), and the box or ghost selected in that view.
 */
export type Place = { readonly path: readonly string[]; readonly selected: string | null };

/**
 * enter: a container child of the open view opens its own view. select: a box or a ghost of the
 * open view; a ghost is selected where it stands, without moving. up: the parent's view, nothing
 * at the root's. home: the
 * root's view. jump: an #id; a container opens its view, a leaf its parent's with the leaf
 * selected, an unknown id the root's. escape: deselects, or with nothing selected goes up.
 * An event that names what the open view does not show leaves the place as it is.
 */
export type PlaceEvent =
  | { readonly type: "enter"; readonly id: string }
  | { readonly type: "select"; readonly id: string }
  | { readonly type: "up" }
  | { readonly type: "home" }
  | { readonly type: "jump"; readonly id: string }
  | { readonly type: "escape" };

export const HOME: Place = { path: [], selected: null };

/** The open container: null for the root. */
export const openOf = (place: Place): string | null => place.path.at(-1) ?? null;

function placeOf(tree: Tree, id: string): Place {
  const node = tree.nodes.get(id);

  if (node === undefined) {
    return HOME;
  }

  const chain = chainOf(tree, id);

  return node.children === undefined
    ? { path: chain.slice(0, -1), selected: id }
    : { path: chain, selected: null };
}

export function navigate(tree: Tree, place: Place, event: PlaceEvent): Place {
  switch (event.type) {
    case "enter": {
      const child = childrenOf(tree, openOf(place)).find((c) => c.id === event.id);

      return child?.children === undefined
        ? place
        : { path: [...place.path, event.id], selected: null };
    }

    case "select": {
      const view = viewOf(tree, openOf(place));

      const shown =
        view.boxes.some((b) => b.id === event.id) || view.ghosts.some((g) => g.id === event.id);

      return shown ? { path: place.path, selected: event.id } : place;
    }

    case "up": {
      return place.path.length === 0 ? place : { path: place.path.slice(0, -1), selected: null };
    }

    case "home": {
      return HOME;
    }

    case "jump": {
      return placeOf(tree, event.id);
    }

    case "escape": {
      return place.selected === null
        ? navigate(tree, place, { type: "up" })
        : { path: place.path, selected: null };
    }

    default: {
      const unknown: never = event;

      return unknown;
    }
  }
}

export type Crumb =
  | { readonly kind: "root" }
  | { readonly kind: "node"; readonly id: string; readonly label: string };

/** The breadcrumb: the root, the path, then the selection when it is a child of the open view. */
export function crumbsOf(tree: Tree, place: Place): Crumb[] {
  const { selected } = place;

  const child =
    selected !== null && childrenOf(tree, openOf(place)).some((c) => c.id === selected)
      ? [selected]
      : [];

  return [
    { kind: "root" },
    ...[...place.path, ...child].map((id): Crumb => ({
      kind: "node",
      id,
      label: nodeOf(tree, id).label,
    })),
  ];
}
