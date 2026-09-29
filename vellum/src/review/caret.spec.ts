import { describe, expect, test } from "bun:test";

import { lineOfOffset, offsetOfLine } from "./caret.ts";

describe("offsetOfLine", () => {
  test("the first line starts at 0", () => {
    expect(offsetOfLine("a\nbb\nccc\n", 1)).toBe(0);
  });

  test("a line starts after the lines before it and their newlines", () => {
    expect(offsetOfLine("a\nbb\nccc\n", 3)).toBe(5);
  });

  test("a line past the end is the end of the text", () => {
    expect(offsetOfLine("a\nbb\n", 9)).toBe(5);
  });
});

describe("lineOfOffset", () => {
  test("the offset of a line's first character is that line, and the end of the text is the last", () => {
    expect(lineOfOffset("a\nbb\nc\n", 0)).toBe(1);
    expect(lineOfOffset("a\nbb\nc\n", 2)).toBe(2);
    expect(lineOfOffset("a\nbb\nc\n", 4)).toBe(2);
    expect(lineOfOffset("a\nbb\nc\n", 5)).toBe(3);
    expect(lineOfOffset("a\nbb\nc\n", 7)).toBe(4);
  });

  test("offsetOfLine and lineOfOffset are inverse on a line's first character", () => {
    const text = "one\ntwo\nthree\n";
    expect(lineOfOffset(text, offsetOfLine(text, 3))).toBe(3);
  });
});
