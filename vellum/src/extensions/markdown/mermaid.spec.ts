import { describe, expect, test } from "bun:test";

import { minWidthOf } from "./mermaid.ts";

describe("minWidthOf", () => {
  test("a drawn diagram shrinks to 0.8 of its width, no further", () => {
    expect(minWidthOf({ baseVal: { width: 1000 } })).toBe("800px");
  });

  test("a diagram with no width takes no minimum", () => {
    expect(minWidthOf({ baseVal: { width: 0 } })).toBeNull();
  });

  test("a viewBox whose baseVal is null, as Firefox leaves it, takes no minimum", () => {
    expect(minWidthOf({ baseVal: null })).toBeNull();
  });
});
