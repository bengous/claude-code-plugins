import { describe, expect, test } from "bun:test";

import SAMPLE from "../../fixtures/sample/map.ts";
import { DEEP, randomMap } from "../../fixtures/trees.ts";
import type { Journey, Step } from "./atlas.ts";
import { joins, journeyOf, stepLights, stepView } from "./journeys.ts";
import type { Tree } from "./tree.ts";
import { chainOf, holds, itemIn, liftIn, treeOf } from "./tree.ts";
import { showsIn, viewOf } from "./view.ts";

const deep = treeOf(DEEP);

const MAPS: [string, Tree][] = [
  ["the sample", treeOf(SAMPLE)],
  ["the deep map", deep],
  ...[1, 2, 3, 5, 8, 13].map((seed): [string, Tree] => [
    `random map ${seed}`,
    treeOf(randomMap(seed)),
  ]),
];

const step = (from: string, to: string): Step => ({ from, to });

const lit = (tree: Tree, s: Step): string[] =>
  viewOf(tree, stepView(tree, s)).arrows.flatMap((a) =>
    stepLights(tree, a, s) ? [`${a.from} → ${a.to}`] : [],
  );

describe("stepView, on the deep map", () => {
  test("both ends in one view: the view of their container, both as cards", () => {
    expect(stepView(deep, step("a1", "a2"))).toBe("A111");
    expect(stepView(deep, step("b2", "b1"))).toBe("B111");
    expect(stepView(deep, step("A1", "A2"))).toBe("A");
  });

  test("ends at different depths: the deeper end's view, the other end a ghost there", () => {
    expect(stepView(deep, step("a1", "a3"))).toBe("A111");
    expect(stepView(deep, step("b3", "b1"))).toBe("B111");
    expect(showsIn(deep, "A111", "a3")).toBe(true);
    expect(viewOf(deep, "A111").boxes.some((b) => b.id === "a3")).toBe(false);
  });

  test("an end shown only as a ghost: an outside leaf, a box at the root, stays a ghost deeper", () => {
    expect(stepView(deep, step("a1", "X"))).toBe("A111");
    expect(stepView(deep, step("X", "a2"))).toBe("A111");
    expect(stepView(deep, step("a6", "X"))).toBe("A2");
  });

  test("a view that shows both ends as ghosts draws no arrow between them: one end is a child", () => {
    expect(showsIn(deep, "A111", "a3")).toBe(true);
    expect(showsIn(deep, "A111", "X")).toBe(true);
    expect(stepView(deep, step("a3", "X"))).toBe("A11");
  });

  test("each end in its own branch: the view of their lowest common container", () => {
    expect(stepView(deep, step("a1", "b1"))).toBeNull();
    expect(stepView(deep, step("y1", "a3"))).toBeNull();
    expect(stepView(deep, step("a5", "a2"))).toBe("A1");
    expect(stepView(deep, step("a1", "a4"))).toBe("A1");
    expect(stepView(deep, step("A12", "a6"))).toBe("A");
    expect(stepView(deep, step("a3", "a6"))).toBe("A");
  });

  test("a step along a two-headed link the other way opens the same view", () => {
    expect(stepView(deep, step("B", "A"))).toBeNull();
    expect(stepView(deep, step("b2", "b1"))).toBe(stepView(deep, step("b1", "b2")));
  });
});

describe("stepView, on every map", () => {
  test.each(MAPS)(
    "%s: every link's view is the deepest that shows both ends, one as a child, else their common container",
    (_, tree) => {
      const containers = [
        null,
        ...[...tree.nodes.values()].flatMap((n) => (n.children === undefined ? [] : [n.id])),
      ];

      const depth = (c: string | null): number => (c === null ? 0 : chainOf(tree, c).length);

      for (const { from, to } of tree.map.links) {
        const ends = [from, to];

        const showing = containers.filter(
          (c) =>
            ends.every((end) => showsIn(tree, c, end)) &&
            ends.some((end) => liftIn(tree, c, end) === end),
        );

        const holding = containers.filter(
          (c) => c !== from && c !== to && ends.every((end) => holds(tree, c, end)),
        );

        const candidates = showing.length > 0 ? showing : holding;
        const open = stepView(tree, step(from, to));

        expect(candidates).toContain(open);
        expect(depth(open)).toBe(Math.max(...candidates.map((c) => depth(c))));
      }
    },
  );
});

describe("stepLights", () => {
  test("in the step's view, one arrow lights: the one between what stands for its ends", () => {
    expect(lit(deep, step("a1", "a2"))).toEqual(["a1 → a2"]);
    expect(lit(deep, step("a3", "X"))).toEqual(["a3 → X"]);
    expect(lit(deep, step("a1", "X"))).toEqual(["a1 → X"]);
  });

  test("in the common container's view, the arrow lifted between the boxes that hold the ends", () => {
    expect(lit(deep, step("a5", "a2"))).toEqual(["A12 → A11"]);
    expect(lit(deep, step("a3", "a6"))).toEqual(["A1 → A2"]);
    expect(lit(deep, step("a1", "b1"))).toEqual(["A → B"]);
    expect(lit(deep, step("y1", "a3"))).toEqual(["Y → A"]);
  });

  test("a two-headed link lights for a step either way; a one-way link only its own way", () => {
    expect(lit(deep, step("B", "A"))).toEqual(["A → B"]);
    expect(lit(deep, step("b1", "b2"))).toEqual(["b1 → b2"]);

    const view = viewOf(deep, "A111");
    const back = step("a2", "a1");

    expect(view.arrows.filter((a) => stepLights(deep, a, back))).toEqual([]);
  });

  test.each(MAPS)(
    "%s: every link, as a step, lights one arrow, between what stands for its ends",
    (_, tree) => {
      for (const link of tree.map.links) {
        const s = step(link.from, link.to);
        const open = stepView(tree, s);
        const ends = [itemIn(tree, open, s.from), itemIn(tree, open, s.to)];
        const arrows = viewOf(tree, open).arrows.filter((a) => stepLights(tree, a, s));
        const [arrow] = arrows;

        expect(arrows).toHaveLength(1);
        expect(ends).toContain(arrow?.from ?? null);
        expect(ends).toContain(arrow?.to ?? null);
        expect(arrow?.from).not.toBe(arrow?.to);
      }
    },
  );
});

describe("joins and journeyOf", () => {
  test("a link joins a step set directly between its ends, the other way only with two", () => {
    expect(joins({ from: "a", to: "b", label: "l" }, step("a", "b"))).toBe(true);
    expect(joins({ from: "a", to: "b", label: "l" }, step("b", "a"))).toBe(false);
    expect(joins({ from: "a", to: "b", label: "l", two: true }, step("b", "a"))).toBe(true);
    expect(joins({ from: "a", to: "c", label: "l" }, step("a", "b"))).toBe(false);
  });

  test("a journey the root declares with a step, by id; none for another id or an empty one", () => {
    const walk: Journey = { id: "walk", label: "Walk", steps: [step("a1", "a2")] };
    const empty: Journey = { id: "empty", label: "Empty", steps: [] };
    const tree = treeOf({ ...DEEP, root: { ...DEEP.root, journeys: [walk, empty] } });

    expect(journeyOf(tree, "walk")).toBe(walk);
    expect(journeyOf(tree, "empty")).toBeNull();
    expect(journeyOf(tree, "nowhere")).toBeNull();
    expect(journeyOf(tree, null)).toBeNull();
    expect(journeyOf(deep, "walk")).toBeNull();
  });
});
