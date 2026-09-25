import { describe, expect, test } from "bun:test";

import { answerOf, chipTitle, endedOf, footerOf, phaseText, progressOf } from "./labels.ts";

describe("footerOf", () => {
  test("names who ended the grill, never the reason's code", () => {
    expect(footerOf("page")).toBe("Ended by you");
    expect(footerOf("stop")).toBe("Ended by /vellum:stop");
    expect(footerOf("approved")).toBe("Ended at approval");
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
    expect(chipTitle("waiting")).toBe("Waiting for your answer");
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

describe("endedOf", () => {
  test("counts the grill's decisions, and says Claude proposes the next step", () => {
    expect(endedOf(8)).toBe("Grill ended: 8 decisions. Claude proposes the next step.");
    expect(endedOf(1)).toBe("Grill ended: 1 decision. Claude proposes the next step.");
    expect(endedOf(0)).toBe("Grill ended: 0 decisions. Claude proposes the next step.");
  });
});
