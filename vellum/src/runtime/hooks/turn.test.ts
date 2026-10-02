import { describe, expect, test, tier } from "claude-code/testing";

import { completed, NO_TURN, ownOf, prompted, replied, started } from "./turn.ts";

tier("user");

/** A relay's row and its turn's text, as the engine frames a plugin's prompt in both. */
const RELAY = "The vellum plugin sent a message:\nReviewer: and hurry";

const TYPED = "and the weather?";

describe("whose turn it is", () => {
  test("a turn that starts on a vellum relay's row is vellum's own", () => {
    expect(ownOf(started(prompted(NO_TURN, RELAY, true), RELAY, "t1"), "t1")).toBe(true);
  });

  test("a turn that starts on another origin's row is not", () => {
    expect(ownOf(started(prompted(NO_TURN, TYPED, false), TYPED, "t1"), "t1")).toBe(false);
  });

  test("two rows before one turn make it vellum's only if both are", () => {
    const relayLast = prompted(prompted(NO_TURN, TYPED, false), RELAY, true);
    const typedLast = prompted(prompted(NO_TURN, RELAY, true), TYPED, false);

    expect(ownOf(started(relayLast, RELAY, "t1"), "t1")).toBe(false);
    expect(ownOf(started(typedLast, TYPED, "t1"), "t1")).toBe(false);
  });

  test("a note left by a row whose turn never came is taken by no other turn", () => {
    const left = prompted(NO_TURN, RELAY, true);

    expect(ownOf(started(left, "", "t1"), "t1")).toBe(false);
    expect(ownOf(started(left, TYPED, "t1"), "t1")).toBe(false);
  });

  test("an empty row and a turn no row was noted for are not own", () => {
    expect(ownOf(started(prompted(NO_TURN, "", true), RELAY, "t1"), "t1")).toBe(false);
    expect(ownOf(started(NO_TURN, RELAY, "t1"), "t1")).toBe(false);
  });

  test("the next prompt's row leaves the running turn's origin alone, and is the next turn's note", () => {
    const over = prompted(started(prompted(NO_TURN, RELAY, true), RELAY, "t1"), TYPED, false);

    expect(ownOf(over, "t1")).toBe(true);
    expect(ownOf(started(completed(over, "t1"), TYPED, "t2"), "t2")).toBe(false);
  });

  test("a note is taken once, and the end of another turn changes nothing", () => {
    const running = started(prompted(NO_TURN, RELAY, true), RELAY, "t1");

    expect(completed(running, "t0")).toBe(running);
    expect(ownOf(started(completed(running, "t1"), RELAY, "t2"), "t2")).toBe(false);
  });

  test("a turn the reviewer answered into, a waiting tool returning their entry, is vellum's own from then on", () => {
    const typed = started(prompted(NO_TURN, TYPED, false), TYPED, "t1");

    expect(ownOf(typed, "t1")).toBe(false);
    expect(ownOf(replied(typed), "t1")).toBe(true);
    expect(replied(NO_TURN)).toBe(NO_TURN);
  });
});
