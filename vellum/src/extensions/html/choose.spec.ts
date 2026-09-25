import { describe, expect, test } from "bun:test";

import type { Marks } from "./choose.ts";
import { choiceOf, optionOf } from "./choose.ts";

function marks(extra: Partial<Marks> = {}): Marks {
  return { choose: false, option: null, decision: null, ...extra };
}

const BUTTON = marks({ choose: true });

const OPTION = marks({ option: "settings" });

const DECISION = marks({ decision: "layout" });

describe("choiceOf", () => {
  test("a Choose names the option it sits in, and the decision that option sits in; `at` is the Choose", () => {
    expect(choiceOf([marks(), BUTTON, marks(), OPTION, marks(), DECISION, marks()])).toEqual({
      at: 1,
      chosen: { decision: "layout", option: "settings" },
    });
  });

  test("an option that is its own Choose is the option chosen", () => {
    expect(choiceOf([marks({ choose: true, option: "tabs" }), DECISION])).toEqual({
      at: 0,
      chosen: { decision: "layout", option: "tabs" },
    });
  });

  test("the nearest option and the nearest decision above it win", () => {
    const inner = marks({ option: "inner", decision: "own" });

    expect(choiceOf([BUTTON, inner, OPTION, marks({ decision: "outer" }), DECISION])).toEqual({
      at: 0,
      chosen: { decision: "outer", option: "inner" },
    });
  });

  test("a click outside a Choose chooses nothing, nor one above the option it reaches", () => {
    expect(choiceOf([marks(), OPTION, DECISION])).toBeNull();
    expect(choiceOf([OPTION, BUTTON, DECISION])).toBeNull();
  });

  test("a Choose outside an option, or an option outside a decision, chooses nothing", () => {
    expect(choiceOf([BUTTON, DECISION])).toBeNull();
    expect(choiceOf([BUTTON, OPTION, marks()])).toBeNull();
  });

  test("an empty option or decision names nothing, and the nearest decision is not skipped for one further up", () => {
    expect(choiceOf([BUTTON, marks({ option: "" }), DECISION])).toBeNull();
    expect(choiceOf([BUTTON, OPTION, marks({ decision: "" }), DECISION])).toBeNull();
  });
});

describe("optionOf", () => {
  test("the option the first element is, in the nearest decision above it", () => {
    expect(optionOf([OPTION, marks(), DECISION])).toEqual({
      decision: "layout",
      option: "settings",
    });
  });

  test("an element that is no option, or an option in no decision, is none", () => {
    expect(optionOf([marks(), OPTION, DECISION])).toBeNull();
    expect(optionOf([OPTION])).toBeNull();
  });
});
