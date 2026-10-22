// What the page has laid out and what it lays out next, pure (no DOM, no promise): engine.ts
// feeds it events and runs one layout at a time; stage.spec.ts runs it.
//
// A view laid out is held with the generation it was laid out for. A relayout opens a new
// generation: the views it names turn stale, kept and shown until a fresh layout of theirs lands,
// and the layout in flight, if any, lands stale and is dropped. A key is wanted now (a navigation)
// or later (a prefetch); the next layout is the oldest want of the first lane that has one.
import type { Key } from "./camera.ts";

export type Priority = "now" | "later";

/** A laid-out view, and the generation it was laid out for. */
export type Held<D> = { readonly drawn: D; readonly gen: number };

export type Stage<D> = {
  readonly gen: number;
  readonly held: ReadonlyMap<Key, Held<D>>;
  /** The one layout in flight, with the generation it started under. */
  readonly drawing: { readonly key: Key; readonly gen: number } | null;
  readonly now: readonly Key[];
  readonly later: readonly Key[];
};

export type StageEvent<D> =
  | { readonly type: "want"; readonly key: Key; readonly priority: Priority }
  | { readonly type: "start" }
  | { readonly type: "done"; readonly key: Key; readonly gen: number; readonly drawn: D }
  | { readonly type: "failed" }
  | { readonly type: "relayout"; readonly stale: (drawn: D) => boolean };

export const EMPTY: Stage<never> = { gen: 0, held: new Map(), drawing: null, now: [], later: [] };

/** The view as held, fresh or stale; null when never laid out. */
export const heldOf = <D>(st: Stage<D>, key: Key): D | null => st.held.get(key)?.drawn ?? null;

/** The view when laid out for the current generation; null when stale or never laid out. */
export function freshOf<D>(st: Stage<D>, key: Key): D | null {
  const held = st.held.get(key);

  return held !== undefined && held.gen === st.gen ? held.drawn : null;
}

/** The key the next layout takes, when none is in flight and one is wanted; the root's is null. */
export function nextOf<D>(st: Stage<D>): { readonly key: Key } | null {
  if (st.drawing !== null) {
    return null;
  }

  const [first] = st.now.length > 0 ? st.now : st.later;

  return first === undefined ? null : { key: first };
}

const without = (keys: readonly Key[], key: Key): Key[] => keys.filter((k) => k !== key);

export function stage<D>(st: Stage<D>, ev: StageEvent<D>): Stage<D> {
  switch (ev.type) {
    case "want": {
      const inFlight = st.drawing?.key === ev.key && st.drawing.gen === st.gen;

      if (freshOf(st, ev.key) !== null || inFlight) {
        return st;
      }

      const now = without(st.now, ev.key);
      const later = without(st.later, ev.key);

      return ev.priority === "now"
        ? { ...st, now: [...now, ev.key], later }
        : { ...st, now, later: [...later, ev.key] };
    }

    case "start": {
      const next = nextOf(st);

      if (next === null) {
        return st;
      }

      return {
        ...st,
        drawing: { key: next.key, gen: st.gen },
        now: without(st.now, next.key),
        later: without(st.later, next.key),
      };
    }

    case "done": {
      if (ev.gen !== st.gen) {
        return { ...st, drawing: null };
      }

      const held = new Map([...st.held, [ev.key, { drawn: ev.drawn, gen: ev.gen }]]);

      return { ...st, held, drawing: null };
    }

    case "failed": {
      return { ...st, drawing: null };
    }

    case "relayout": {
      const gen = st.gen + 1;

      const held = new Map(
        [...st.held].map(([key, h]): [Key, Held<D>] => [
          key,
          ev.stale(h.drawn) ? h : { ...h, gen },
        ]),
      );

      return { ...st, gen, held, now: [], later: [] };
    }

    default: {
      const unknown: never = ev;

      return unknown;
    }
  }
}
