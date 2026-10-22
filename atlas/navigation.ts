import type { Tree } from "./tree.ts";
import { chainOf, childrenOf, nodeOf } from "./tree.ts";
import { showsIn } from "./view.ts";

/**
 * Where the reader stands: the containers from a child of the root down to the open one (empty:
 * the root's view), and the box or ghost selected in that view.
 */
export type Place = { readonly path: readonly string[]; readonly selected: string | null };

/**
 * - enter: a container child of the open view opens its own view.
 * - select: a box or a ghost of the open view; a ghost is selected where it stands, without moving.
 * - up: the parent's view; at the root's, nothing.
 * - home: the root's view.
 * - jump: a bare #id; a container opens its view, a leaf its parent's with the leaf selected, an
 *   unknown id the root's.
 * - escape: deselects, or with nothing selected goes up.
 *
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

const samePlace = (a: Place, b: Place): boolean =>
  a.selected === b.selected &&
  a.path.length === b.path.length &&
  a.path.every((id, i) => b.path[i] === id);

const SEPARATOR = "/";

/**
 * The URL fragment of a place, without its "#": the bare id a jump would land on the place with
 * ("" for the root's view), or, when no jump lands there (a selected ghost or container, a
 * selection on the root's view other than an outside leaf), the open container and the selection
 * as `<open>/<selected>`, the root's view written as nothing before the slash. Each id is
 * percent-encoded.
 */
export function hashOf(tree: Tree, place: Place): string {
  const open = openOf(place);
  const bare = place.selected ?? open;

  if (bare === null) {
    return "";
  }

  if (samePlace(placeOf(tree, bare), place)) {
    return encodeURIComponent(bare);
  }

  return [open ?? "", place.selected ?? ""].map((id) => encodeURIComponent(id)).join(SEPARATOR);
}

const decoded = (text: string): string | null => {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
};

/**
 * The place a URL fragment names, with or without its "#": a bare id as a jump reads it, and
 * `<open>/<selected>` as the open container's view with that box or ghost selected. A fragment
 * that does not decode or names no container opens the root's view; a selection the view does
 * not show is dropped.
 */
export function placeOfHash(tree: Tree, hash: string): Place {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  const slash = fragment.indexOf(SEPARATOR);

  if (slash === -1) {
    return placeOf(tree, decoded(fragment) ?? "");
  }

  const open = decoded(fragment.slice(0, slash));
  const selected = decoded(fragment.slice(slash + 1));

  if (open === null || selected === null) {
    return HOME;
  }

  const select = { type: "select", id: selected } as const;

  if (open === "") {
    return navigate(tree, HOME, select);
  }

  if (tree.nodes.get(open)?.children === undefined) {
    return HOME;
  }

  return navigate(tree, { path: chainOf(tree, open), selected: null }, select);
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
      return showsIn(tree, openOf(place), event.id)
        ? { path: place.path, selected: event.id }
        : place;
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

/** `selected`: the crumb names the selection, not a container on the path. */
export type Crumb =
  | { readonly kind: "root" }
  | {
      readonly kind: "node";
      readonly id: string;
      readonly label: string;
      readonly selected: boolean;
    };

/**
 * The breadcrumb: the root, each container of the path, then the selection, box or ghost, marked
 * selected. Two places never share a breadcrumb.
 */
export function crumbsOf(tree: Tree, place: Place): Crumb[] {
  const crumb = (id: string, selected: boolean): Crumb => ({
    kind: "node",
    id,
    label: nodeOf(tree, id).label,
    selected,
  });

  return [
    { kind: "root" },
    ...place.path.map((id) => crumb(id, false)),
    ...(place.selected === null ? [] : [crumb(place.selected, true)]),
  ];
}
