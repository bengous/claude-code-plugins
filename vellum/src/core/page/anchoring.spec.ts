import { describe, expect, test } from "bun:test";

import { parseLines } from "./anchoring.ts";

describe("parseLines", () => {
  test("a `data-lines` value is its first and its last line", () => {
    expect(parseLines("12-15")).toEqual([12, 15]);
  });

  test("a block of one line starts and ends on it", () => {
    expect(parseLines("3-3")).toEqual([3, 3]);
  });

  test("an element without the attribute has no lines", () => {
    expect(parseLines(undefined)).toBeNull();
  });

  test.each(["", "12", "12-", "-15", "a-b", " 12-15", "12-15-18", "undefined"])(
    "%p is not the format, and yields no number",
    (value) => {
      expect(parseLines(value)).toBeNull();
    },
  );
});
