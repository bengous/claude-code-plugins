import { describe, expect, test } from "bun:test";

import type { Root, RootContent } from "hast";

import { parseLines } from "../../review/surface.ts";
import { toTree } from "./tree.ts";

/** The property `name` of every `tag` element of the tree, in document order. */
function propertyOf(text: string, tag: string, name: string): unknown[] {
  const found: unknown[] = [];

  const walk = (node: Root | RootContent): void => {
    if (node.type === "element" && node.tagName === tag) found.push(node.properties[name]);

    if ("children" in node) for (const child of node.children) walk(child);
  };

  walk(toTree(text));

  return found;
}

const linesOf = (text: string, tag: string): unknown[] => propertyOf(text, tag, "dataLines");

/** The class of every span the highlighter adds inside the code. */
const spanClasses = (text: string): unknown[] => propertyOf(text, "span", "className");

const fencedOf = (text: string): unknown[] => propertyOf(text, "pre", "dataFenced");

describe("toTree", () => {
  test("a code block opened by a fence is marked fenced, an indented one is not", () => {
    const text = "```ts\na\n```\n\n> ~~~\n> b\n> ~~~\n\n    ```\n    c\n";

    expect(fencedOf(text)).toEqual([true, true, undefined]);
  });

  test("a lone carriage return ends a line, as the parser counts it", () => {
    expect(fencedOf("a\rb\n\n```\nx\n```\n")).toEqual([true]);
  });

  test("what it writes in `data-lines` is what `parseLines` reads", () => {
    const written = linesOf("A paragraph\nof two lines.\n\nAnother.\n", "p");

    expect(written.map((value) => parseLines(String(value)))).toEqual([
      [1, 2],
      [4, 4],
    ]);
  });

  test("a list item's lines stop before its nested list", () => {
    expect(linesOf("- First item\n  - Nested one\n  - Nested two\n- Second item\n", "li")).toEqual([
      "1-1",
      "2-2",
      "3-3",
      "4-4",
    ]);
  });

  test("a loose item stops before its nested list, even with text after it", () => {
    expect(linesOf("- First\n  continued\n\n  - Nested\n\n  after\n", "li")).toEqual([
      "1-2",
      "4-4",
    ]);
  });

  test("a list keeps its full lines", () => {
    expect(linesOf("- First item\n  - Nested one\n  - Nested two\n- Second item\n", "ul")).toEqual([
      "1-4",
      "2-3",
    ]);
  });

  test("a ts block is coloured, and its pre keeps its lines", () => {
    const text = "```ts\nconst answer = 42;\n```\n";

    expect(spanClasses(text)).toContainEqual(["hljs-keyword"]);
    expect(linesOf(text, "pre")).toEqual(["1-3"]);
  });

  test("a mermaid block is not coloured, and keeps its lines", () => {
    const text = "```mermaid\nflowchart TD\n  A --> B\n```\n";

    expect(spanClasses(text)).toEqual([]);
    expect(linesOf(text, "pre")).toEqual(["1-4"]);
  });
});
