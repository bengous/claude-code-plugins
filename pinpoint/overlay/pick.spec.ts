import { describe, expect, test } from "bun:test";

import {
  boxBetween,
  covers,
  labelOf,
  outermost,
  selectorOf,
  type Step,
  targetIndex,
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
