import { describe, expect, test, tier } from "claude-code/testing";

import { submitResult } from "./hooks.ts";

tier("user");

describe("submitResult", () => {
  test("a version tells the model to end its turn, recorded or kept: it acts the same on both", () => {
    expect(submitResult({ version: 1, kept: false })).toEqual({
      result: "Plan v1 under review. End your turn.",
    });
    expect(submitResult({ version: 2, kept: true })).toEqual({
      result: "Plan v2 under review. End your turn.",
    });
  });

  test("an error is the deny the model reads", () => {
    expect(submitResult({ error: "write plan.md in x/ first" })).toEqual({
      deny: "write plan.md in x/ first",
    });
  });
});
