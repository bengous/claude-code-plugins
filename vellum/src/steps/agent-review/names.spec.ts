import { describe, expect, test } from "bun:test";

import { reviewFile } from "./names.ts";

describe("reviewFile", () => {
  test("the first review of a version by a model is named by both", () => {
    expect(reviewFile(3, "claude-opus-5-5", new Set())).toBe("reviews/v3-claude-opus-5-5.md");
  });

  test("the next ones by the same model on the same version take -2, then -3", () => {
    const taken = new Set(["v3-claude-opus-5-5.md", "v3-claude-opus-5-5-2.md"]);

    expect(reviewFile(3, "claude-opus-5-5", taken)).toBe("reviews/v3-claude-opus-5-5-3.md");
  });

  test("another model or another version starts over", () => {
    const taken = new Set(["v3-claude-opus-5-5.md"]);

    expect(reviewFile(3, "claude-sonnet-5", taken)).toBe("reviews/v3-claude-sonnet-5.md");
    expect(reviewFile(4, "claude-opus-5-5", taken)).toBe("reviews/v4-claude-opus-5-5.md");
  });

  test("the model keeps lower-case letters, digits, dots and dashes alone", () => {
    expect(reviewFile(1, "Claude-Opus-5-5[1m]", new Set())).toBe("reviews/v1-claude-opus-5-51m.md");
    expect(reviewFile(1, "../x/y z", new Set())).toBe("reviews/v1-..xyz.md");
  });
});
