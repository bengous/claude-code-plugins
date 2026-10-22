import { describe, expect, test } from "bun:test";

import type { Key } from "./camera.ts";
import type { Stage, StageEvent } from "./stage.ts";
import { EMPTY, freshOf, heldOf, nextOf, stage } from "./stage.ts";

type Drawn = { readonly key: Key; readonly mode: "packed" | "layered"; readonly run: number };

const run = (st: Stage<Drawn>, events: readonly StageEvent<Drawn>[]): Stage<Drawn> =>
  events.reduce((at, ev) => stage(at, ev), st);

const want = (key: Key, priority: "now" | "later" = "now"): StageEvent<Drawn> => ({
  type: "want",
  key,
  priority,
});

const START: StageEvent<Drawn> = { type: "start" };

const drawnOf = (key: Key, count: number, mode: Drawn["mode"] = "packed"): Drawn => ({
  key,
  mode,
  run: count,
});

// Three views laid out, the root's and A's packed, L's layered.
function laid(): Stage<Drawn> {
  const runs = { count: 0 };
  let st = run(EMPTY, [want(null), want("A"), want("L")]);
  st = layOut(st, runs);
  st = layOut(st, runs);
  st = stage(st, START);

  return stage(st, { type: "done", key: "L", gen: 0, drawn: drawnOf("L", 3, "layered") });
}

const packed = (d: Drawn): boolean => d.mode === "packed";

// Lays out what the stage asks for, one at a time, as engine.ts does: `done` carries the
// generation the layout started under.
function layOut(st: Stage<Drawn>, runs: { count: number }): Stage<Drawn> {
  const next = nextOf(st);

  if (next === null) {
    return st;
  }

  const started = stage(st, START);
  const gen = started.drawing?.gen ?? -1;
  runs.count += 1;

  return stage(started, { type: "done", key: next.key, gen, drawn: drawnOf(next.key, runs.count) });
}

describe("wants and layouts", () => {
  test("a view wanted is laid out once and then fresh", () => {
    const runs = { count: 0 };
    let st = run(EMPTY, [want("A"), want("A")]);

    expect(nextOf(st)).toEqual({ key: "A" });

    st = layOut(st, runs);

    expect(freshOf(st, "A")).toEqual(drawnOf("A", 1));
    expect(nextOf(st)).toBeNull();
    expect(stage(st, want("A"))).toBe(st);
    expect(runs.count).toBe(1);
  });

  test("the root's view, keyed null, is wanted and laid out like any other", () => {
    const st = run(EMPTY, [want(null, "later"), want("A", "later")]);

    expect(nextOf(st)).toEqual({ key: null });
    expect(freshOf(layOut(st, { count: 0 }), null)).toEqual(drawnOf(null, 1));
  });

  test("a navigation goes before the prefetches, in the order asked", () => {
    const st = run(EMPTY, [want("p1", "later"), want("p2", "later"), want("n1"), want("n2")]);

    const order: Key[] = [];
    let at = st;
    const runs = { count: 0 };

    for (let next = nextOf(at); next !== null; next = nextOf(at)) {
      order.push(next.key);
      at = layOut(at, runs);
    }

    expect(order).toEqual(["n1", "n2", "p1", "p2"]);
  });

  test("a prefetch wanted again as a navigation moves to the front", () => {
    const st = run(EMPTY, [want("p1", "later"), want("p2", "later"), want("p2")]);

    expect(st.now).toEqual(["p2"]);
    expect(st.later).toEqual(["p1"]);
  });

  test("one layout at a time: a want during a layout waits for it", () => {
    const st = run(EMPTY, [want("A"), START, want("B")]);

    expect(st.drawing).toEqual({ key: "A", gen: 0 });
    expect(nextOf(st)).toBeNull();
    expect(stage(st, want("A"))).toBe(st);

    const done = stage(st, { type: "done", key: "A", gen: 0, drawn: drawnOf("A", 1) });

    expect(nextOf(done)).toEqual({ key: "B" });
  });

  test("a failed layout frees the stage for the next want", () => {
    const st = run(EMPTY, [want("A"), START, want("B"), { type: "failed" }]);

    expect(st.drawing).toBeNull();
    expect(freshOf(st, "A")).toBeNull();
    expect(nextOf(st)).toEqual({ key: "B" });
  });
});

describe("a relayout", () => {
  test("keeps the stale views until a fresh layout replaces them, and the others fresh", () => {
    const st = stage(laid(), { type: "relayout", stale: packed });

    expect(st.gen).toBe(1);
    expect(freshOf(st, null)).toBeNull();
    expect(heldOf(st, null)).toEqual(drawnOf(null, 1));
    expect(freshOf(st, "L")).toEqual(drawnOf("L", 3, "layered"));
    expect(nextOf(st)).toBeNull();

    const runs = { count: 3 };
    const again = layOut(stage(st, want(null)), runs);

    expect(freshOf(again, null)).toEqual(drawnOf(null, 4));
  });

  test("drops the prefetches wanted before it", () => {
    const st = stage(run(laid(), [want("p", "later"), want("q")]), {
      type: "relayout",
      stale: packed,
    });

    expect(nextOf(st)).toBeNull();
  });

  test("during a layout, drops that layout and lays the view out again when wanted", () => {
    const runs = { count: 0 };
    let st = run(EMPTY, [want("A"), START]);
    st = stage(st, { type: "relayout", stale: packed });
    st = stage(st, want("A"));

    expect(st.now).toEqual(["A"]);
    expect(nextOf(st)).toBeNull();

    st = stage(st, { type: "done", key: "A", gen: 0, drawn: drawnOf("A", 1) });

    expect(heldOf(st, "A")).toBeNull();
    expect(nextOf(st)).toEqual({ key: "A" });

    st = layOut(st, runs);

    expect(freshOf(st, "A")).toEqual(drawnOf("A", 1));
    expect(nextOf(st)).toBeNull();
  });

  test("twice during one layout still lands one fresh layout", () => {
    let st = run(EMPTY, [want("A"), START]);
    st = stage(st, { type: "relayout", stale: packed });
    st = stage(st, { type: "relayout", stale: packed });
    st = stage(st, want("A"));
    st = stage(st, { type: "done", key: "A", gen: 0, drawn: drawnOf("A", 1) });
    st = layOut(st, { count: 1 });

    expect(st.gen).toBe(2);
    expect(freshOf(st, "A")).toEqual(drawnOf("A", 2));
  });
});

describe("whatever the order of events", () => {
  const KEYS: Key[] = [null, "A", "B", "C"];

  test("every view wanted after the last relayout ends fresh once the layouts run dry", () => {
    let seed = 7;

    const next = (): number => {
      seed = (seed * 48_271) % 2_147_483_647;

      return seed / 2_147_483_647;
    };

    for (let round = 0; round < 200; round += 1) {
      let st: Stage<Drawn> = EMPTY;
      let wanted = new Set<Key>();
      const runs = { count: 0 };

      for (let step = 0; step < 30; step += 1) {
        const roll = next();
        const key = KEYS[Math.floor(next() * KEYS.length)] ?? null;

        if (roll < 0.45) {
          st = stage(st, want(key, next() < 0.5 ? "now" : "later"));
          wanted.add(key);
        } else if (roll < 0.6) {
          st = stage(st, { type: "relayout", stale: () => next() < 0.5 });
          wanted = new Set();
        } else if (st.drawing === null) {
          const started = stage(st, START);
          st = started;
        } else {
          const { key: inFlight, gen } = st.drawing;
          runs.count += 1;
          st = stage(st, {
            type: "done",
            key: inFlight,
            gen,
            drawn: drawnOf(inFlight, runs.count),
          });
        }
      }

      for (const key of wanted) {
        st = stage(st, want(key));
      }

      let guard = 0;

      while (nextOf(st) !== null || st.drawing !== null) {
        st = st.drawing === null ? stage(st, START) : layOutInFlight(st, runs);
        guard += 1;
        expect(guard).toBeLessThan(100);
      }

      for (const key of wanted) {
        expect(freshOf(st, key)).not.toBeNull();
      }
    }
  });
});

function layOutInFlight(st: Stage<Drawn>, runs: { count: number }): Stage<Drawn> {
  if (st.drawing === null) {
    throw new Error("nothing in flight");
  }

  const { key, gen } = st.drawing;
  runs.count += 1;

  return stage(st, { type: "done", key, gen, drawn: drawnOf(key, runs.count) });
}
