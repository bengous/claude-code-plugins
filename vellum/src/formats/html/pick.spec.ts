import { describe, expect, test } from "bun:test";

import type { Step } from "./pick.ts";
import { selectorOf, targetIndex } from "./pick.ts";

function step(tag: string, extra: Partial<Step> = {}): Step {
  return { tag, id: null, classes: [], nthOfType: 1, sameTagSiblings: 1, ...extra };
}

describe("selectorOf", () => {
  test("the nearest ancestor with an id starts the chain", () => {
    expect(
      selectorOf([
        step("main"),
        step("section", { id: "pricing" }),
        step("div", { classes: ["card"] }),
      ]),
    ).toBe("section#pricing > div.card");
  });

  test("a tag with same-tag siblings is placed by :nth-of-type", () => {
    expect(
      selectorOf([
        step("section", { id: "pricing" }),
        step("div", { classes: ["card"], nthOfType: 2, sameTagSiblings: 3 }),
      ]),
    ).toBe("section#pricing > div.card:nth-of-type(2)");
  });

  test("every class of the element is kept", () => {
    expect(selectorOf([step("div", { classes: ["card", "wide"] })])).toBe("body > div.card.wide");
  });

  test("without an id the chain is anchored at body, so a deeper twin does not match", () => {
    expect(selectorOf([step("div"), step("div"), step("p")])).toBe("body > div > div > p");
  });
});

describe("targetIndex", () => {
  test("a path inside an svg lifts to the svg", () => {
    expect(targetIndex(["path", "g", "svg", "div", "body", "html"])).toBe(2);
  });

  test("html and body alone are no target", () => {
    expect(targetIndex(["body", "html"])).toBeNull();
  });
});
