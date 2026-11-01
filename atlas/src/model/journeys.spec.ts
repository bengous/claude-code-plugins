import { describe, expect, test } from "bun:test";

import JOURNEYS from "../../fixtures/journeys/map.ts";
import SAMPLE from "../../fixtures/sample/map.ts";
import { DEEP, randomMap } from "../../fixtures/trees.ts";
import type { Journey, Node, Section, Step } from "./atlas.ts";
import type { Numbered } from "./journeys.ts";
import {
  drawnIn,
  formAfter,
  formBefore,
  hostView,
  indexMark,
  indexOf,
  isEntry,
  joins,
  journeyOf,
  playView,
  rangeText,
  rangesOf,
  rangesText,
  reachedBefore,
  representativeIn,
  stepView,
  stepsOf,
  tracedIn,
} from "./journeys.ts";
import type { Tree } from "./tree.ts";
import { chainOf, holds, liftIn, treeOf } from "./tree.ts";
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

const shop = treeOf(JOURNEYS);

describe("drawnIn and representativeIn", () => {
  test("a view draws its children, the chips of its container children and its ghosts", () => {
    expect(["reader", "edge", "proxy", "db", "bank"].map((id) => drawnIn(shop, null, id))).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(["routes", "pricing", "payment"].map((id) => drawnIn(shop, null, id))).toEqual([
      false,
      false,
      false,
    ]);
    expect(["pricing", "cart", "bank"].map((id) => drawnIn(shop, "checkout", id))).toEqual([
      true,
      true,
      true,
    ]);
    expect(drawnIn(shop, "checkout", "db")).toBe(false);
    expect(drawnIn(shop, "checkout", "checkout")).toBe(false);
    expect(drawnIn(shop, null, "nowhere")).toBe(false);
  });

  test("what draws a node stands for it, else the box or ghost of the view that holds it, else nothing", () => {
    expect(representativeIn(shop, null, "proxy")).toBe("proxy");
    expect(representativeIn(shop, null, "pricing")).toBe("app");
    expect(representativeIn(shop, "checkout", "db")).toBe("data");
    expect(representativeIn(shop, "checkout", "cart")).toBe("cart");
    expect(representativeIn(shop, "checkout", "reader")).toBeNull();
    expect(representativeIn(shop, "checkout", "app")).toBeNull();
    expect(representativeIn(shop, "checkout", "nowhere")).toBeNull();
    expect(representativeIn(deep, "A111", "a4")).toBe("A12");
  });
});

const journeyOn = (tree: Tree, id: string): Journey => {
  const journey = journeyOf(tree, id);

  if (journey === null) {
    throw new Error(`no journey ${id}`);
  }

  return journey;
};

const viewsOf = (tree: Tree, journey: Journey): (string | null)[] => {
  const host = hostView(tree, journey);

  return stepsOf(journey).map(({ step: at }) => playView(tree, host, at));
};

describe("hostView and playView, on the journeys fixture", () => {
  test("no container draws every end of a fixture's journey: each is hosted by the root", () => {
    for (const id of ["place-order", "sign-in", "pay-and-confirm"]) {
      expect(hostView(shop, journeyOn(shop, id))).toBeNull();
    }
  });

  test("a step plays in the root when it draws both ends, else the deepest view that does, else stepView's", () => {
    expect(viewsOf(shop, journeyOn(shop, "place-order"))).toEqual([
      null,
      null,
      "app",
      "checkout",
      "checkout",
      null,
      null,
      null,
    ]);
    expect(viewsOf(shop, journeyOn(shop, "sign-in"))).toEqual([null, null, "web", null]);
    expect(viewsOf(shop, journeyOn(shop, "pay-and-confirm"))).toEqual([
      "checkout",
      "checkout",
      "checkout",
      "checkout",
      null,
      null,
      null,
    ]);
    expect(stepView(shop, step("payment", "db"))).toBeNull();
  });
});

const node = (id: string): Node => ({ id, label: id, sub: "", color: "c" });

const holder = (id: string, children: readonly Node[]): Node => ({ ...node(id), children });

// Two ends below S, side by side, that S draws as children, the root does not, and P1 and Q1, a
// level deeper, both draw as ghosts.
const TWINS = treeOf({
  root: {
    title: "Twins",
    children: [
      holder("T", [
        holder("S", [node("e1"), node("e2"), holder("P1", [node("p")]), holder("Q1", [node("q")])]),
      ]),
      node("Z"),
      node("W"),
    ],
  },
  links: [
    { from: "p", to: "e1", label: "pe1" },
    { from: "p", to: "e2", label: "pe2" },
    { from: "q", to: "e1", label: "qe1" },
    { from: "q", to: "e2", label: "qe2" },
    { from: "Z", to: "W", label: "zw" },
  ],
});

const walking = (steps: readonly Step[]): Journey => ({
  id: "walk",
  label: "Walk",
  sections: [{ label: "Walk", steps }],
});

describe("hostView and playView, among views alike", () => {
  test("the host is the deepest view that draws every end, the first depth-first among the deepest", () => {
    expect(hostView(TWINS, walking([step("e1", "e2")]))).toBe("P1");
    expect(hostView(TWINS, walking([step("e1", "p")]))).toBe("P1");
    expect(hostView(TWINS, walking([step("e1", "Q1")]))).toBe("S");
    expect(hostView(TWINS, walking([step("Z", "W"), step("e1", "e2")]))).toBeNull();
  });

  test("a step the host does not draw plays in the deepest view that draws both, the first depth-first", () => {
    const journey = walking([step("Z", "W"), step("e1", "e2")]);

    expect(viewsOf(TWINS, journey)).toEqual([null, "P1"]);
    expect(playView(TWINS, "Q1", step("e1", "e2"))).toBe("Q1");
    expect(playView(TWINS, "Q1", step("Z", "W"))).toBeNull();
  });
});

describe("hostView, playView and tracedIn, on every map", () => {
  test.each(MAPS)(
    "%s: the host draws every end, no deeper view does; every step plays in a view that traces it",
    (_, tree) => {
      const journey: Journey = {
        id: "links",
        label: "Every link",
        sections: [{ label: "Links", steps: tree.map.links.map((l) => step(l.from, l.to)) }],
      };

      const ends = stepsOf(journey).flatMap(({ step: at }) => [at.from, at.to]);
      const host = hostView(tree, journey);
      const depth = (c: string | null): number => (c === null ? 0 : chainOf(tree, c).length);

      expect(host === null || ends.every((end) => drawnIn(tree, host, end))).toBe(true);

      for (const id of tree.order) {
        if (tree.nodes.get(id)?.children !== undefined && depth(id) > depth(host)) {
          expect(ends.every((end) => drawnIn(tree, id, end))).toBe(false);
        }
      }

      for (const at of stepsOf(journey)) {
        const open = playView(tree, host, at.step);
        const traced = tracedIn(tree, open, journey, 1).find((t) => t.at.n === at.n);

        expect(traced).toBeDefined();
        expect(traced?.from).not.toBe(traced?.to);
      }
    },
  );
});

describe("tracedIn", () => {
  const pay = journeyOn(shop, "pay-and-confirm");

  const traced = (container: string | null, s: number): [number, string, string][] =>
    tracedIn(shop, container, pay, s).map(({ at, from, to }) => [at.n, from, to]);

  test("in the view a section plays in, each step between what stands for its ends", () => {
    expect(traced("checkout", 1)).toEqual([
      [1, "cart", "pricing"],
      [2, "pricing", "payment"],
      [3, "payment", "bank"],
      [4, "bank", "payment"],
      [5, "payment", "data"],
    ]);
    expect(traced(null, 2)).toEqual([
      [6, "db", "outbox"],
      [7, "outbox", "mailer"],
    ]);
  });

  test("a step whose ends share what stands for them, or with an end nothing stands for, is not traced", () => {
    expect(traced(null, 1)).toEqual([
      [3, "app", "bank"],
      [4, "bank", "app"],
      [5, "app", "db"],
    ]);
    expect(traced("data", 1)).toEqual([[5, "app", "db"]]);
    expect(traced("edge", 1)).toEqual([]);
  });
});

// Rocky's example: with its first section shown, the box offres carries "2, 5, 6–8, 10", 2 and
// 6–8 of that section, 5 a return of it, 10 of the next section.
const OFFERS = treeOf({
  root: {
    title: "Offers",
    children: [
      holder("offres", [node("o1"), node("o2"), node("o3")]),
      holder("cand", [node("c1"), node("c2")]),
    ],
  },
  links: [],
});

const OFFERING: Journey = {
  id: "offering",
  label: "Offering",
  sections: [
    {
      label: "Find",
      steps: [
        { from: "c1", to: "o1", trigger: "Look", kind: "manual" },
        step("o1", "o2"),
        step("o2", "c1"),
        step("c1", "c2"),
        { from: "o2", to: "o1", back: true },
        step("o1", "o3"),
        step("o3", "o2"),
        step("o2", "o3"),
        step("o3", "c2"),
      ],
    },
    {
      label: "Apply",
      steps: [{ from: "o1", to: "o2", trigger: "Apply", kind: "manual" }, step("o2", "c1")],
    },
  ],
};

const numbers = (tree: Tree, journey: Journey, box: string): number[] =>
  indexOf(tree, journey, box).map(({ n }) => n);

function offering(n: number): Numbered {
  const found = stepsOf(OFFERING)[n - 1];

  if (found === undefined) {
    throw new Error(`no step ${n}`);
  }

  return found;
}

describe("a box's index", () => {
  test("the steps of every section whose two ends are below the box, in order", () => {
    const pay = journeyOn(shop, "pay-and-confirm");

    expect(numbers(OFFERS, OFFERING, "offres")).toEqual([2, 5, 6, 7, 8, 10]);
    expect(numbers(OFFERS, OFFERING, "cand")).toEqual([4]);
    expect(numbers(shop, pay, "app")).toEqual([1, 2]);
    expect(numbers(shop, pay, "shop")).toEqual([1, 2]);
    expect(numbers(shop, pay, "checkout")).toEqual([2]);
    expect(numbers(shop, pay, "data")).toEqual([6]);
    expect(numbers(shop, pay, "edge")).toEqual([]);
  });

  test("a step with an end outside the box, or at the box itself, is not in its index", () => {
    const walk = walking([step("checkout", "cart"), step("cart", "db")]);

    expect(numbers(shop, walk, "checkout")).toEqual([]);
    expect(numbers(shop, walk, "shop")).toEqual([1]);
    expect(numbers(shop, walk, "app")).toEqual([1]);
    expect(numbers(shop, walk, "data")).toEqual([]);
  });

  test("a number is the section shown's, a return of that section's, or another section's", () => {
    expect([2, 5, 10].map((n) => indexMark(offering(n), 1))).toEqual(["current", "back", "other"]);
    expect([2, 5, 10].map((n) => indexMark(offering(n), 2))).toEqual(["other", "other", "current"]);
  });

  test("in ranges: numbers one after another merge, two of them too, only those of one mark", () => {
    const offres = indexOf(OFFERS, OFFERING, "offres");
    const app = indexOf(shop, journeyOn(shop, "pay-and-confirm"), "app");

    expect(rangesOf(offres, 1)).toEqual([
      { first: 2, last: 2, mark: "current" },
      { first: 5, last: 5, mark: "back" },
      { first: 6, last: 8, mark: "current" },
      { first: 10, last: 10, mark: "other" },
    ]);
    expect(rangesOf(offres, 2)).toEqual([
      { first: 2, last: 2, mark: "other" },
      { first: 5, last: 8, mark: "other" },
      { first: 10, last: 10, mark: "current" },
    ]);
    expect(rangesOf(app, 1)).toEqual([{ first: 1, last: 2, mark: "current" }]);
    expect(rangesOf([], 1)).toEqual([]);
  });

  test("written: a range's ends joined by an en dash, the ranges by a comma, no prefix", () => {
    const offres = indexOf(OFFERS, OFFERING, "offres");

    expect(rangesText(rangesOf(offres, 1))).toBe("2, 5, 6–8, 10");
    expect(rangesText(rangesOf(offres, 2))).toBe("2, 5–8, 10");
    expect(rangeText({ first: 6, last: 7, mark: "current" })).toBe("6–7");
    expect(rangeText({ first: 4, last: 4, mark: "other" })).toBe("4");
  });
});

describe("joins and journeyOf", () => {
  test("a link joins a step set directly between its ends, the other way only with two", () => {
    expect(joins({ from: "a", to: "b", label: "l" }, step("a", "b"))).toBe(true);
    expect(joins({ from: "a", to: "b", label: "l" }, step("b", "a"))).toBe(false);
    expect(joins({ from: "a", to: "b", label: "l", two: true }, step("b", "a"))).toBe(true);
    expect(joins({ from: "a", to: "c", label: "l" }, step("a", "b"))).toBe(false);
  });

  test("a step back follows a link set from its to to its from, never one set its own way", () => {
    const back: Step = { from: "b", to: "a", back: true };

    expect(joins({ from: "a", to: "b", label: "l" }, back)).toBe(true);
    expect(joins({ from: "a", to: "b", label: "l", two: true }, back)).toBe(true);
    expect(joins({ from: "b", to: "a", label: "l" }, back)).toBe(false);
    expect(joins({ from: "b", to: "a", label: "l", two: true }, back)).toBe(false);
  });

  test("a journey the root declares with a step in any section, by id; none for another id or one without a step", () => {
    const walk: Journey = {
      id: "walk",
      label: "Walk",
      sections: [
        { label: "Nothing yet", steps: [] },
        { label: "Walk", steps: [step("a1", "a2")] },
      ],
    };

    const empty: Journey = { id: "empty", label: "Empty", sections: [{ label: "E", steps: [] }] };
    const bare: Journey = { id: "bare", label: "Bare", sections: [] };
    const tree = treeOf({ ...DEEP, root: { ...DEEP.root, journeys: [walk, empty, bare] } });

    expect(journeyOf(tree, "walk")).toBe(walk);
    expect(journeyOf(tree, "empty")).toBeNull();
    expect(journeyOf(tree, "bare")).toBeNull();
    expect(journeyOf(tree, "nowhere")).toBeNull();
    expect(journeyOf(tree, null)).toBeNull();
    expect(journeyOf(deep, "walk")).toBeNull();
  });
});

const PAYING: Section = {
  label: "Pay",
  steps: [
    { from: "cart", to: "pricing", trigger: "Check out", kind: "manual", carries: "the cart" },
    { from: "pricing", to: "payment" },
    { from: "payment", to: "bank", carries: "a charge" },
    { from: "bank", to: "payment", back: true },
  ],
};

const CONFIRMING: Section = {
  label: "Confirm",
  steps: [
    { from: "db", to: "outbox", trigger: "Every minute", kind: "auto" },
    { from: "outbox", to: "mailer", carries: "a confirmation" },
  ],
};

const PAY: Journey = {
  id: "pay",
  label: "Pay",
  sections: [PAYING, { label: "Wait", steps: [] }, CONFIRMING],
};

describe("a journey's steps", () => {
  test("are numbered from 1 across the sections, each with its section, numbered from 1", () => {
    expect(
      stepsOf(PAY).map(({ n, s, section, step: at }) => [n, s, section.label, at.from]),
    ).toEqual([
      [1, 1, "Pay", "cart"],
      [2, 1, "Pay", "pricing"],
      [3, 1, "Pay", "payment"],
      [4, 1, "Pay", "bank"],
      [5, 3, "Confirm", "db"],
      [6, 3, "Confirm", "outbox"],
    ]);
  });

  test("an entry carries a trigger and a kind; a step with only one of them is none", () => {
    // SAFETY: a trigger without a kind, as a map folder's data can hold once it skips its typecheck.
    const half = { from: "a", to: "b", trigger: "Go" } as Step;

    expect(stepsOf(PAY).map(({ step: at }) => isEntry(at))).toEqual([
      true,
      false,
      false,
      false,
      true,
      false,
    ]);
    expect(isEntry(half)).toBe(false);
  });

  test("a section has reached the ends of its steps before the one asked, none of another's", () => {
    expect([...reachedBefore(PAYING, 0)]).toEqual([]);
    expect([...reachedBefore(PAYING, 2)]).toEqual(["cart", "pricing", "payment"]);
    expect([...reachedBefore(CONFIRMING, 1)]).toEqual(["db", "outbox"]);
  });

  test("the data's form after a step: the last carries from its section's start to it, none before or in another section", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => formAfter(PAY, n))).toEqual([
      "the cart",
      "the cart",
      "a charge",
      "a charge",
      null,
      "a confirmation",
      null,
    ]);
  });

  test("the data's form as a step starts: the form after the step before it in its section, none for a section's first", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => formBefore(PAY, n))).toEqual([
      null,
      "the cart",
      "the cart",
      "a charge",
      null,
      null,
    ]);
  });
});
