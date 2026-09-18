import { describe, expect, test } from "bun:test";

import type { LinedBlock } from "./marked.ts";
import { markedIndices } from "./marked.ts";

function block(tag: string, lines: string): LinedBlock {
  return { tag, lines };
}

describe("markedIndices", () => {
  test("a passage on one line marks the innermost block holding it", () => {
    const blocks = [block("blockquote", "1-3"), block("p", "1-1"), block("p", "3-3")];
    expect([...markedIndices(blocks, [[3, 3]])]).toEqual([2]);
  });

  test("a passage over two blocks marks both", () => {
    const blocks = [block("p", "1-1"), block("p", "3-3")];
    expect([...markedIndices(blocks, [[1, 3]])]).toEqual([0, 1]);
  });

  test("a line no block holds marks nothing", () => {
    expect([...markedIndices([block("p", "1-1")], [[5, 5]])]).toEqual([]);
  });

  test("a table row is marked, never its cell", () => {
    const blocks = [block("tr", "2-2"), block("td", "2-2")];
    expect([...markedIndices(blocks, [[2, 2]])]).toEqual([0]);
  });
});
