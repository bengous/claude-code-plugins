import { describe, expect, test, tier } from "claude-code/testing";

import { completed, NO_TURN, ownOf, prompted, started } from "./turn.ts";

tier("user");

const RELAY = "Reviewer: and hurry";

const TYPED = "and the weather?";

describe("whose turn it is", () => {
  test("a turn that starts on a vellum relay's text is vellum's own, framed by the engine or not", () => {
    const noted = prompted(NO_TURN, RELAY, true);

    expect(ownOf(started(noted, RELAY, "t1"), "t1")).toBe(true);
    expect(ownOf(started(noted, `The vellum plugin sent a message: ${RELAY}`, "t1"), "t1")).toBe(
      true,
    );
  });

  test("a turn that starts on what the terminal typed is not", () => {
    expect(ownOf(started(prompted(NO_TURN, TYPED, false), TYPED, "t1"), "t1")).toBe(false);
  });

  test("a relay and a typed prompt that wait together leave one note: neither turn is own", () => {
    const noted = prompted(prompted(NO_TURN, RELAY, true), TYPED, false);

    expect(ownOf(started(noted, RELAY, "t1"), "t1")).toBe(false);
    expect(ownOf(started(noted, TYPED, "t2"), "t2")).toBe(false);
  });

  test("another text, an empty note, and a turn no prompt was noted for are not own", () => {
    expect(ownOf(started(prompted(NO_TURN, RELAY, true), "rewritten", "t1"), "t1")).toBe(false);
    expect(ownOf(started(prompted(NO_TURN, "", true), RELAY, "t1"), "t1")).toBe(false);
    expect(ownOf(started(NO_TURN, RELAY, "t1"), "t1")).toBe(false);
  });

  test("a prompt typed over a running turn leaves that turn's origin alone, and is the next turn's note", () => {
    const over = prompted(started(prompted(NO_TURN, RELAY, true), RELAY, "t1"), TYPED, false);

    expect(ownOf(over, "t1")).toBe(true);
    expect(ownOf(started(completed(over, "t1"), TYPED, "t2"), "t2")).toBe(false);
  });

  test("a note is taken once, and the end of another turn changes nothing", () => {
    const running = started(prompted(NO_TURN, RELAY, true), RELAY, "t1");

    expect(completed(running, "t0")).toBe(running);
    expect(ownOf(started(completed(running, "t1"), RELAY, "t2"), "t2")).toBe(false);
  });
});
