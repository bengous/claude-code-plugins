import { describe, expect, test } from "bun:test";

import { declineFailure, footerOf, waitingOf } from "./labels.ts";

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
