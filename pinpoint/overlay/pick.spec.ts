import { describe, expect, test } from "bun:test";

import {
  boxBetween,
  covers,
  labelOf,
  outermost,
  pageBox,
  type PointerInput,
  pressAfter,
  selectorOf,
  type Step,
  targetIndex,
  viewportBox,
} from "./pick.ts";

function step(tag: string, more: Partial<Step> = {}): Step {
  return { tag, id: null, classes: [], nthOfType: 1, sameTagSiblings: 1, ...more };
}

describe("selectorOf", () => {
  test("anchors at body with no id on the way, ranking same-tag siblings", () => {
    const steps = [
      step("main"),
      step("li", { classes: ["row", "1bad"], nthOfType: 2, sameTagSiblings: 3 }),
    ];

    expect(selectorOf(steps)).toBe("body > main > li.row:nth-of-type(2)");
  });

  test("anchors at the nearest id a selector can carry", () => {
    const steps = [step("div", { id: "app" }), step("section", { id: "1st" }), step("button")];

    expect(selectorOf(steps)).toBe("div#app > section > button");
  });
});

test("labelOf names an element by its id, else its first class", () => {
  expect(labelOf(step("button", { id: "save", classes: ["btn"] }))).toBe("button#save");
  expect(labelOf(step("button", { classes: ["btn", "primary"] }))).toBe("button.btn");
  expect(labelOf(step("p"))).toBe("p");
});

test("targetIndex picks the outermost svg, else the first element below body", () => {
  expect(targetIndex(["path", "g", "svg", "div", "body", "html"])).toBe(2);
  expect(targetIndex(["span", "button", "body", "html"])).toBe(0);
  expect(targetIndex(["body", "html"])).toBeNull();
});

describe("covers", () => {
  const zone = { x: 0, y: 0, width: 100, height: 100 };

  test("half of an element's box in the zone is enough, less is not", () => {
    expect(covers(zone, { x: 50, y: 0, width: 100, height: 10 })).toBe(true);
    expect(covers(zone, { x: 60, y: 0, width: 100, height: 10 })).toBe(false);
  });

  test("an empty box is covered by nothing", () => {
    expect(covers(zone, { x: 10, y: 10, width: 0, height: 0 })).toBe(false);
  });
});

test("boxBetween takes two corners in any order", () => {
  expect(boxBetween({ x: 30, y: 5 }, { x: 10, y: 25 })).toEqual({
    x: 10,
    y: 5,
    width: 20,
    height: 20,
  });
});

test("outermost drops a node held by another one of the list, at any depth", () => {
  const parents = new Map<string, string | null>([
    ["main", null],
    ["section", "main"],
    ["p", "section"],
    ["aside", null],
  ]);

  expect(outermost(["main", "p", "aside"], (node) => parents.get(node) ?? null)).toEqual([
    "main",
    "aside",
  ]);
});

test("pageBox adds the scroll at the pick, viewportBox takes off the scroll now", () => {
  const seen = { x: 300, y: 350, width: 200, height: 60 };
  const onPage = pageBox(seen, { x: 0, y: 800 });

  expect(onPage).toEqual({ x: 300, y: 1150, width: 200, height: 60 });
  expect(viewportBox(onPage, { x: 0, y: 300 })).toEqual({ x: 300, y: 850, width: 200, height: 60 });
  expect(viewportBox(onPage, { x: 0, y: 800 })).toEqual(seen);
});

describe("pressAfter", () => {
  const outside: Omit<PointerInput, "type"> = {
    inside: false,
    button: 0,
    x: 10,
    y: 20,
    adding: false,
  };

  const press = { x: 10, y: 20, adding: false };

  test("the main button down outside the overlay starts a press; inside it, or another button, does not", () => {
    expect(pressAfter(null, { ...outside, type: "pointerdown" })).toEqual({ press, picks: null });
    expect(pressAfter(null, { ...outside, type: "pointerdown", inside: true }).press).toBeNull();
    expect(pressAfter(null, { ...outside, type: "pointerdown", button: 2 }).press).toBeNull();
  });

  test("a move keeps the press, over the overlay too", () => {
    expect(pressAfter(press, { ...outside, type: "pointermove" })).toEqual({ press, picks: null });
    expect(pressAfter(press, { ...outside, type: "pointermove", inside: true })).toEqual({
      press,
      picks: null,
    });
  });

  test("a release outside the overlay ends the press and picks from it", () => {
    expect(pressAfter(press, { ...outside, type: "pointerup", x: 90 })).toEqual({
      press: null,
      picks: press,
    });
  });

  test("a release over the overlay, or a cancel anywhere, ends the press and picks nothing", () => {
    const ended = { press: null, picks: null };

    expect(pressAfter(press, { ...outside, type: "pointerup", inside: true })).toEqual(ended);
    expect(pressAfter(press, { ...outside, type: "pointercancel" })).toEqual(ended);
    expect(pressAfter(press, { ...outside, type: "pointercancel", inside: true })).toEqual(ended);
  });
});
