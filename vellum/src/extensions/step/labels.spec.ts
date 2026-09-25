import { describe, expect, test } from "bun:test";

import { answerFailure, detailOf } from "./labels.ts";

describe("answerFailure", () => {
  test("says a proposal no longer waiting, a refusal in the server's words, and where an answer that did not land waits", () => {
    expect(answerFailure(409, "no such proposal")).toBe(
      "Claude's proposal was already answered or replaced.",
    );
    expect(answerFailure(409, "grill 2 is open")).toBe("The step was refused: grill 2 is open.");
    expect(answerFailure(500, null)).toBe("The step was refused: the server answered 500.");
    expect(answerFailure(null, null)).toBe(
      "The step did not reach the server: it waits on the Next step button.",
    );
  });
});

describe("detailOf", () => {
  test("names what a move is about, and what the plan does", () => {
    expect(detailOf({ kind: "grill", subject: "auth", choices: [] })).toBe("auth");
    expect(detailOf({ kind: "mockup", screen: "the bar" })).toBe("the bar");
    expect(detailOf({ kind: "prototype", question: "drag or click?" })).toBe("drag or click?");
    expect(detailOf({ kind: "plan" })).toBe("Write the plan now");
  });
});
