import { describe, expect, test } from "bun:test";

import { answerOf, chipTitle, declineFailure, footerOf, waitingOf } from "./labels.ts";

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

describe("waitingOf", () => {
  test("counts the questions that wait for the reviewer, and says nothing of none", () => {
    expect(waitingOf(0)).toBeNull();
    expect(waitingOf(1)).toBe("1 question waiting");
    expect(waitingOf(2)).toBe("2 questions waiting");
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
