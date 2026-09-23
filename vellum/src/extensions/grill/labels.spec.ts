import { describe, expect, test } from "bun:test";

import { answerOf, chipTitle, declineFailure, footerOf, phaseText, progressOf } from "./labels.ts";

describe("footerOf", () => {
  test("names who ended the grill, never the reason's code", () => {
    expect(footerOf("page")).toBe("Ended by you");
    expect(footerOf("stop")).toBe("Ended by /vellum:stop");
    expect(footerOf("approved")).toBe("Ended at approval");
  });
});

describe("declineFailure", () => {
  test("says a 409 is a proposal no longer pending, and where a decline that did not land waits", () => {
    expect(declineFailure(409)).toBe("Claude's proposal was already answered or replaced.");
    expect(declineFailure(null)).toBe(
      "The decline did not reach the server: the proposal waits on the Grill button.",
    );
    expect(declineFailure(500)).toBe("The decline was refused: the server answered 500.");
  });
});

describe("progressOf", () => {
  test("says the round and the questions that wait for the reviewer, and nothing of none", () => {
    expect(progressOf(2, 2)).toBe("round 2 · 2 questions waiting");
    expect(progressOf(1, 1)).toBe("round 1 · 1 question waiting");
    expect(progressOf(2, 0)).toBe("round 2");
    expect(progressOf(0, 1)).toBe("1 question waiting");
    expect(progressOf(0, 0)).toBeNull();
  });
});

describe("answerOf", () => {
  test("reads an answer by its kind, and says which the reviewer never chose", () => {
    expect(answerOf({ kind: "open" })).toBeNull();
    expect(answerOf({ kind: "default" })).toEqual({ label: "By default", text: "As recommended." });
    expect(answerOf({ kind: "recommended" })).toEqual({
      label: "Your answer",
      text: "As recommended.",
    });
    expect(answerOf({ kind: "typed", text: "plain" })).toEqual({
      label: "Your answer",
      text: "plain",
    });
  });
});

describe("chipTitle", () => {
  test("says in words what a chip's colour says", () => {
    expect(chipTitle("answered")).toBe("Answered");
    expect(chipTitle("default")).toBe("Taken as recommended, by default");
    expect(chipTitle("waiting")).toBe("Waiting: a send takes it as recommended");
  });
});

describe("phaseText", () => {
  test("says which round Claude prepares while it works", () => {
    expect(phaseText("working", 0)).toBe("Claude is preparing the first round.");
    expect(phaseText("working", 2)).toBe("Claude is preparing round 3.");
  });

  test("says nothing while a round is open, and how Claude's turn ended once it did", () => {
    expect(phaseText("asking", 1)).toBe("");
    expect(phaseText("idle", 1)).toBe("Claude has no question open.");
    expect(phaseText("stopped", 1)).toBe("Claude's turn was interrupted. Add a note to continue.");
  });
});
