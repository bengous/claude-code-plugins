import { describe, expect, test } from "bun:test";

import { waitingText } from "./sheet.ts";

describe("waitingText", () => {
  test("a loaded document prints nothing over itself", () => {
    expect(waitingText(true, false)).toBe(null);
  });

  test("a first load in flight waits", () => {
    expect(waitingText(false, false)).toBe("Loading…");
  });

  test("a first load that failed says so instead of waiting", () => {
    expect(waitingText(false, true)).toBe("This document could not be loaded.");
  });

  test("a reload that failed keeps the document on screen", () => {
    expect(waitingText(true, true)).toBe(null);
  });
});
