import { describe, expect, test, tier } from "claude-code/testing";

import { completed, NO_TURN, ownOf, prompted, replied, started } from "./turn.ts";

tier("user");

describe("whose turn it is", () => {
  test("a turn that starts after a vellum relay's row is vellum's own", () => {
    expect(ownOf(started(prompted(NO_TURN, true), "t1"), "t1")).toBe(true);
  });

  test("a turn that starts after another origin's row is not", () => {
    expect(ownOf(started(prompted(NO_TURN, false), "t1"), "t1")).toBe(false);
  });

  test("the row kept last before the turn decides", () => {
    expect(ownOf(started(prompted(prompted(NO_TURN, false), true), "t1"), "t1")).toBe(true);
    expect(ownOf(started(prompted(prompted(NO_TURN, true), false), "t1"), "t1")).toBe(false);
  });

  test("a turn no row was noted for is not own", () => {
    expect(ownOf(started(NO_TURN, "t1"), "t1")).toBe(false);
  });

  test("the next prompt's row leaves the running turn's origin alone, and is the next turn's note", () => {
    const over = prompted(started(prompted(NO_TURN, true), "t1"), false);

    expect(ownOf(over, "t1")).toBe(true);
    expect(ownOf(started(completed(over, "t1"), "t2"), "t2")).toBe(false);
  });

  test("a note is taken once, and the end of another turn changes nothing", () => {
    const running = started(prompted(NO_TURN, true), "t1");

    expect(completed(running, "t0")).toBe(running);
    expect(ownOf(started(completed(running, "t1"), "t2"), "t2")).toBe(false);
  });

  test("a turn the reviewer answered into, a waiting tool returning their entry, is vellum's own from then on", () => {
    const typed = started(prompted(NO_TURN, false), "t1");

    expect(ownOf(typed, "t1")).toBe(false);
    expect(ownOf(replied(typed), "t1")).toBe(true);
    expect(replied(NO_TURN)).toBe(NO_TURN);
  });
});
