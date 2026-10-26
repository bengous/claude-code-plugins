import type { Journey, Step } from "./atlas.ts";
import { cardsOf } from "./cards.ts";
import { journeyOf, stepView } from "./journeys.ts";
import type { Tree } from "./tree.ts";
import { chainOf, childrenOf, nodeOf } from "./tree.ts";
import { showsIn, viewOf } from "./view.ts";

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

/**
 * The place as the tree can show it: its path cut where it stops being a chain of containers down
 * from the root (a stale or hand-made path), and its selection dropped when that view does not show
 * it. A place the tree shows comes back as it is.
 */
export function normalised(tree: Tree, place: Place): Place {
  const broken = place.path.findIndex((id, i) => {
    const chain = tree.nodes.get(id)?.children === undefined ? [] : chainOf(tree, id);

    return chain.length !== i + 1 || (i > 0 && chain[i - 1] !== place.path[i - 1]);
  });

  const path = broken === -1 ? place.path : place.path.slice(0, broken);
  const open = path.at(-1) ?? null;
  const shown = place.selected !== null && showsIn(tree, open, place.selected);
  const selected = shown ? place.selected : null;

  return path === place.path && selected === place.selected ? place : { path, selected };
}

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

/**
 * How the open container's view shows: "map", its drawing, or "cards", its leaf children side by
 * side.
 */
export type Mode = "map" | "cards";

/**
 * Where the reader stands beyond the place, one field per parameter of the URL fragment. The
 * fragment's grammar, without its "#":
 *
 *     fragment  = place [ "?" parameter *( "&" parameter ) ]
 *     place     = "" | id | [ id ] "/" id
 *     parameter = key "=" value
 *
 * such as `app?mode=cards`, `app/email?mode=cards&phase=MVP`, `?phase=MVP` on the root's
 * view, or `app/email?phase=MVP&journey=place-order&step=3`; the place is hashOf's. Every id and
 * every value is percent-encoded (encodeURIComponent), which
 * escapes "/", "?", "&" and "=": no id holds a raw separator, so a reader cuts the parameters off
 * at the first "?" before it reads the place at its first "/".
 *
 * Every parameter follows these rules:
 * - A key is a field of Params, written as its name, and a value its codec's text (PARAMS).
 * - A parameter at its default is not written, and the others follow the order PARAMS lists
 *   them: a reading at every default writes the place alone.
 * - A key PARAMS does not name, a part without "=", a value that does not decode or that its
 *   codec refuses, is dropped, keeping the place and every other parameter, as a selection the
 *   view does not show is dropped; of a key given twice, the first value read counts.
 * - A value the place or the map cannot show goes back to its default, written, read and moved
 *   alike (shownAt): the cards, where the open container has none (cardsOf), or on a journey,
 *   whose arrow they cannot show; a phase the Config does not list (Scope); a journey the root
 *   does not declare, or without a step; a step past its journey's last, or without a journey.
 * - What survives a move (paramsAfter): the mode goes back to "map" when the open container
 *   changes; a phase stays across moves; a journey is a place of its own, which a move outside
 *   the journey leaves.
 * - A journey and its step, `journey=<id>&step=<n>` with n from 1, show the view of that step
 *   (shownPlace, stepView in journeys.ts), nothing selected; the place written before them is
 *   where the journey started, which leaving it returns to. Every move is made from the step's
 *   view and leaves the journey; another step, or another journey, is no move and keeps that
 *   place. A phase picked stays on a journey.
 * - `window.atlas` shows each field (pageStateOf).
 *
 * A new parameter is a field here, its default in DEFAULTS, its codec in PARAMS, its rule in
 * paramsAfter, and what a place or the map cannot show of it in shownAt.
 */
export type Params = {
  readonly mode: Mode;
  /** The work phase picked, one of the Config's: what comes after it dims. Null: every phase. */
  readonly phase: string | null;
  /** The journey played, by its id, one the root declares. Null: none. */
  readonly journey: string | null;
  /** The step of the journey shown, from 1. */
  readonly step: number;
};

export const DEFAULTS: Params = { mode: "map", phase: null, journey: null, step: 1 };

/**
 * What the fragment's parameters are read and written against: the map's tree, and its Config's
 * work phases in order (Settings).
 */
export type Scope = { readonly tree: Tree; readonly phases: readonly string[] };

/** A parameter's value as the fragment writes it: null, at its default, leaves it out. */
type Codec<V> = {
  readonly read: (text: string) => V | null;
  readonly write: (value: V) => string | null;
};

/** One codec per parameter: its key is the field's name. */
type Codecs = { readonly [K in keyof Params]: Codec<Params[K]> };

const MODES: readonly Mode[] = ["map", "cards"];

const STEP = /^[1-9][0-9]*$/u;

const PARAMS: Codecs = {
  mode: {
    read: (text) => MODES.find((mode) => mode === text) ?? null,
    write: (mode) => (mode === DEFAULTS.mode ? null : mode),
  },
  phase: {
    read: (text) => (text === "" ? null : text),
    write: (phase) => phase,
  },
  journey: {
    read: (text) => (text === "" ? null : text),
    write: (journey) => journey,
  },
  step: {
    read: (text) => (STEP.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null),
    write: (step) => (step === DEFAULTS.step ? null : String(step)),
  },
};

const isParam = (key: string): key is keyof Params => Object.hasOwn(PARAMS, key);

const SEPARATOR = "/";

const PARAMS_START = "?";

const PARAMS_JOIN = "&";

const VALUE_START = "=";

/** The journey the parameters play and the step they show of it, or null off a journey. */
function playedOf(tree: Tree, params: Params): { journey: Journey; step: number } | null {
  const journey = journeyOf(tree, params.journey);

  if (journey === null) {
    return null;
  }

  const { step } = params;
  const fits = Number.isInteger(step) && step >= 1 && step <= journey.steps.length;

  return { journey, step: fits ? step : DEFAULTS.step };
}

/** The parameters as a place, normalised, and the map can show them (Params gives the rules). */
function shownAt({ tree, phases }: Scope, place: Place, params: Params): Params {
  const played = playedOf(tree, params);
  const cards = params.mode === "cards" && played === null && cardsOf(tree, openOf(place)) !== null;
  const phase = params.phase !== null && phases.includes(params.phase);

  return {
    mode: cards ? params.mode : DEFAULTS.mode,
    phase: phase ? params.phase : DEFAULTS.phase,
    journey: played?.journey.id ?? DEFAULTS.journey,
    step: played?.step ?? DEFAULTS.step,
  };
}

/** The step of a journey the parameters show, as the map can show them; null off a journey. */
export function stepShown(scope: Scope, params: Params): Step | null {
  const played = playedOf(scope.tree, params);

  return played?.journey.steps[played.step - 1] ?? null;
}

/**
 * The place the page shows: `given`, as the tree can show it (normalised), or on a journey the
 * view of its step (stepView), nothing selected; `given` is then where the journey started.
 */
export function shownPlace(scope: Scope, given: Place, params: Params): Place {
  const place = normalised(scope.tree, given);
  const step = stepShown(scope, params);

  if (step === null) {
    return place;
  }

  const open = stepView(scope.tree, step);

  return { path: open === null ? [] : chainOf(scope.tree, open), selected: null };
}

/**
 * The parameters after a move from one place to another, as the second can show them (Params
 * says what survives a move); on a journey, `from` is the step's view (shownPlace).
 */
export function paramsAfter(scope: Scope, from: Place, to: Place, params: Params): Params {
  const place = normalised(scope.tree, to);
  const moved = openOf(normalised(scope.tree, from)) !== openOf(place);
  const left = { ...params, journey: DEFAULTS.journey, step: DEFAULTS.step };

  return shownAt(scope, place, moved ? { ...left, mode: DEFAULTS.mode } : left);
}

function placeHash(tree: Tree, place: Place): string {
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

function written<K extends keyof Params>(key: K, params: Params): string[] {
  const text = PARAMS[key].write(params[key]);

  return text === null ? [] : [`${key}${VALUE_START}${encodeURIComponent(text)}`];
}

/**
 * The URL fragment of a place and its parameters, without its "#" (Params gives the grammar).
 * The place is the bare id a jump would land on it with ("" for the root's view), or, when no
 * jump lands there (a selected ghost or container, a selection on the root's view other than an
 * outside leaf), the open container and the selection as `<open>/<selected>`, the root's view
 * written as nothing before the slash. Each id is percent-encoded. A place and its parameters are
 * written as the map can show them (normalised, shownAt).
 */
export function hashOf(scope: Scope, given: Place, params: Params = DEFAULTS): string {
  const { tree } = scope;
  const place = normalised(tree, given);
  const shown = shownAt(scope, place, params);

  const parts = Object.keys(PARAMS).flatMap((key) => (isParam(key) ? written(key, shown) : []));

  return (
    placeHash(tree, place) + (parts.length === 0 ? "" : PARAMS_START + parts.join(PARAMS_JOIN))
  );
}

/**
 * What an agent reads of the page in `window.atlas`, without a screenshot: frozen, and replaced
 * at each move of the reader; each parameter of the fragment as its own field.
 */
export type PageState = Params & {
  /**
   * The containers from a child of the root down to the open one, the step's on a journey
   * (shownPlace); empty on the root's view.
   */
  readonly path: readonly string[];
  readonly selected: string | null;
  /** The nodes the open view draws, each once: its boxes, the chips in them, its ghosts. */
  readonly visible: readonly string[];
  /** The URL's fragment, without its "#" (hashOf): on a journey, the place it started from. */
  readonly fragment: string;
};

/**
 * The page's state at a place and its parameters, as the map can show them (normalised, shownAt,
 * shownPlace).
 */
export function pageStateOf(scope: Scope, given: Place, params: Params = DEFAULTS): PageState {
  const { tree } = scope;
  const place = normalised(tree, given);
  const shown = shownPlace(scope, place, params);
  const view = viewOf(tree, openOf(shown));

  const visible = new Set([
    ...view.boxes.flatMap((box) => [
      box.id,
      ...(box.kind === "container" ? box.chips.map((chip) => chip.id) : []),
    ]),
    ...view.ghosts.map((ghost) => ghost.id),
  ]);

  return Object.freeze({
    ...shownAt(scope, place, params),
    path: Object.freeze([...shown.path]),
    selected: shown.selected,
    visible: Object.freeze([...visible]),
    fragment: hashOf(scope, place, params),
  });
}

const decoded = (text: string): string | null => {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
};

const fragmentOf = (hash: string): string => (hash.startsWith("#") ? hash.slice(1) : hash);

/** A fragment cut where its parameters start: the place's part, then the parameters' part. */
function cut(hash: string): readonly [string, string] {
  const fragment = fragmentOf(hash);
  const start = fragment.indexOf(PARAMS_START);

  return start === -1 ? [fragment, ""] : [fragment.slice(0, start), fragment.slice(start + 1)];
}

// The parameters with the one a key names set from its text, or null when its codec refuses it.
function withParam<K extends keyof Params>(params: Params, key: K, text: string): Params | null {
  const value = PARAMS[key].read(text);

  return value === null ? null : { ...params, [key]: value };
}

/** A part of the parameters as a key and its decoded text, or nothing when it has neither. */
function entryOf(part: string): [string, string][] {
  const start = part.indexOf(VALUE_START);
  const text = start === -1 ? null : decoded(part.slice(start + 1));

  return text === null ? [] : [[part.slice(0, start), text]];
}

/**
 * The parameters a URL fragment carries, with or without its "#", as the place it names and the
 * map can show them: each at its default where the fragment gives none it can read (Params gives
 * the grammar and its rules).
 */
export function paramsOfHash(scope: Scope, hash: string): Params {
  const entries = cut(hash)[1]
    .split(PARAMS_JOIN)
    .flatMap((part) => entryOf(part));

  const read = new Set<keyof Params>();
  let params = DEFAULTS;

  for (const [key, text] of entries) {
    if (isParam(key) && !read.has(key)) {
      const next = withParam(params, key, text);

      if (next !== null) {
        read.add(key);
        params = next;
      }
    }
  }

  return shownAt(scope, placeOfHash(scope.tree, hash), params);
}

/**
 * The place a URL fragment names, with or without its "#", its parameters cut off: a bare id as
 * a jump reads it, and `<open>/<selected>` as the open container's view with that box or ghost
 * selected. A fragment that does not decode or names no container opens the root's view; a
 * selection the view does not show is dropped.
 */
export function placeOfHash(tree: Tree, hash: string): Place {
  const [fragment] = cut(hash);
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

/** The place an event leads to, from `given` as the tree can show it (normalised). */
export function navigate(tree: Tree, given: Place, event: PlaceEvent): Place {
  const place = normalised(tree, given);

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
 * selected. Two places never share a breadcrumb. A place is read as the tree can show it
 * (normalised).
 */
export function crumbsOf(tree: Tree, given: Place): Crumb[] {
  const place = normalised(tree, given);

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

/** A crumb shown, or the levels folded into one. */
export type Shown = Crumb | { readonly kind: "fold"; readonly crumbs: readonly Crumb[] };

const KEPT_END = 2;

// Folding fewer saves nothing: the fold is as wide as a short label.
const FOLD_FROM = 5;

/**
 * The breadcrumb on one line: from FOLD_FROM crumbs on, the levels between the root and the last
 * KEPT_END fold into one that names them all.
 */
export function foldedCrumbs(crumbs: readonly Crumb[]): Shown[] {
  if (crumbs.length < FOLD_FROM) {
    return [...crumbs];
  }

  return [
    ...crumbs.slice(0, 1),
    { kind: "fold", crumbs: crumbs.slice(1, -KEPT_END) },
    ...crumbs.slice(-KEPT_END),
  ];
}
