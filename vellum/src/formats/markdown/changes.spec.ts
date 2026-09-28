import { describe, expect, test } from "bun:test";

import type { Element } from "hast";

import type { DiffRun, LineDiff } from "../../runtime/protocol.ts";
import type { RemovedRun } from "./changes.ts";
import { changesOf, removedLabel } from "./changes.ts";
import { toTree } from "./tree.ts";

function named(element: Element): string {
  return `${element.tagName} ${String(element.properties.dataLines)}`;
}

function marked(text: string, diff: LineDiff): string[] {
  return [...changesOf(toTree(text), diff).marked].map((element) => named(element));
}

function removed(before: number, at: number): DiffRun {
  return { kind: "removed", before, at, lines: ["old"] };
}

function names(runs: readonly RemovedRun[]): string {
  return runs.map((run) => run.before).join(", ");
}

/** Where each removed run of `diff` is drawn in `text`, the runs named by their `before` line. */
function placed(text: string, diff: LineDiff): string[] {
  const changes = changesOf(toTree(text), diff);

  return [
    ...[...changes.removedBefore].map(([anchor, runs]) => `${names(runs)} before ${named(anchor)}`),
    ...[...changes.removedInside].map(([anchor, runs]) => `${names(runs)} inside ${named(anchor)}`),
    ...(changes.removedAtEnd.length === 0 ? [] : [`${names(changes.removedAtEnd)} at the end`]),
  ];
}

describe("changesOf, the marks", () => {
  test("an added run inside one list item marks that item, not the list", () => {
    const diff: LineDiff = [{ kind: "added", after: 2, count: 1 }];
    expect(marked("- one\n- two\n- three\n", diff)).toEqual(["li 2-2"]);
  });

  test("a change on a parent item's own line marks the parent, not its nested items", () => {
    const diff: LineDiff = [{ kind: "added", after: 1, count: 1 }];
    expect(marked("- parent\n  - nested one\n  - nested two\n", diff)).toEqual(["li 1-1"]);
  });

  test("a run over a parent's own line and a nested item marks both, each for its own line", () => {
    const diff: LineDiff = [{ kind: "added", after: 1, count: 2 }];
    expect(marked("- parent\n  - nested one\n  - nested two\n", diff)).toEqual([
      "li 1-1",
      "li 2-2",
    ]);
  });

  test("a block holding the changed block is not marked", () => {
    const diff: LineDiff = [{ kind: "added", after: 3, count: 1 }];
    expect(marked("> first\n>\n> second\n", diff)).toEqual(["p 3-3"]);
  });

  test("a loose item's only paragraph marks the item, as the tight form does", () => {
    const diff: LineDiff = [{ kind: "added", after: 3, count: 1 }];
    expect(marked("- one\n\n- two\n\n- three\n", diff)).toEqual(["li 3-3"]);
  });

  test("the second paragraph of an item marks that paragraph", () => {
    const diff: LineDiff = [{ kind: "added", after: 3, count: 1 }];
    expect(marked("- one\n\n  second\n", diff)).toEqual(["p 3-3"]);
  });

  test("an added line in the blank between two blocks marks nothing", () => {
    const diff: LineDiff = [{ kind: "added", after: 2, count: 1 }];
    expect(marked("First.\n\nSecond.\n", diff)).toEqual([]);
  });
});

describe("changesOf, the removed runs", () => {
  test("a removed run goes before the first block at or after its line", () => {
    const text = "# Title\n\nFirst.\n\nSecond\nparagraph.\n";
    expect(placed(text, [removed(1, 6)])).toEqual(["1 before p 5-6"]);
  });

  test("inside the list item when that block is one", () => {
    expect(placed("Intro.\n\n- one\n- two\n", [removed(1, 4)])).toEqual(["1 inside li 4-4"]);
  });

  test("inside the nested item when that block is one", () => {
    const text = "- parent\n  - nested one\n  - nested two\n";
    expect(placed(text, [removed(1, 3)])).toEqual(["1 inside li 3-3"]);
  });

  test("before the paragraph of a quote, never before the quote", () => {
    expect(placed("# T\n\n> first\n>\n> second\n", [removed(1, 5)])).toEqual(["1 before p 5-5"]);
  });

  test("before the row when that block is one: the renderer makes it a row", () => {
    const text = "| a | b |\n| - | - |\n| 1 | 2 |\n";
    expect(placed(text, [removed(1, 3)])).toEqual(["1 before tr 3-3"]);
  });

  test("at the end when its line is past the last", () => {
    expect(placed("# Title\n", [removed(1, 2)])).toEqual(["1 at the end"]);
  });

  test("the runs of one diff go each to its own place", () => {
    const text = "Intro.\n\n- one\n- two\n";
    expect(placed(text, [removed(1, 1), removed(5, 4)])).toEqual([
      "1 before p 1-1",
      "5 inside li 4-4",
    ]);
  });

  test("two removed runs on one anchor come out in document order", () => {
    const text = "# T\n\nOne.\n";
    expect(placed(text, [removed(3, 3), removed(5, 3)])).toEqual(["3, 5 before p 3-3"]);
  });
});

describe("changesOf, the lines of a code block", () => {
  function addedLines(text: string, diff: LineDiff): string[] {
    return [...changesOf(toTree(text), diff).addedLines].map(
      ([element, lines]) => `${named(element)}: ${lines.join(", ")}`,
    );
  }

  test("an added line in a fenced block is named by its index in the block, the fence not counted", () => {
    const text = "```ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```\n";
    const diff: LineDiff = [{ kind: "added", after: 3, count: 1 }];
    expect(addedLines(text, diff)).toEqual(["pre 1-5: 1"]);
  });

  test("a run over several lines names each, and the fences never", () => {
    const text = "```ts\na\nb\n```\n";
    const diff: LineDiff = [{ kind: "added", after: 1, count: 4 }];
    expect(addedLines(text, diff)).toEqual(["pre 1-4: 0, 1"]);
  });

  test("an indented block has no fence: its first, middle and last line are named from 0", () => {
    const text = "Intro.\n\n    a\n    b\n    c\n";
    const diff: LineDiff = [{ kind: "added", after: 3, count: 3 }];
    expect(addedLines(text, diff)).toEqual(["pre 3-5: 0, 1, 2"]);
  });

  test("a fence closed by its quote or by the end of the file has code on its last line", () => {
    const diff: LineDiff = [{ kind: "added", after: 1, count: 3 }];
    expect(addedLines("> ```\n> a\n> b\n\nNext.\n", diff)).toEqual(["pre 1-3: 0, 1"]);
    expect(addedLines("```\na\nb", diff)).toEqual(["pre 1-3: 0, 1"]);
  });

  test("an added paragraph names no line", () => {
    const diff: LineDiff = [{ kind: "added", after: 1, count: 1 }];
    expect(addedLines("One.\n", diff)).toEqual([]);
  });
});

describe("removedLabel", () => {
  test("one line is singular", () => {
    expect(removedLabel(1)).toBe("1 line removed");
  });

  test("two lines are plural", () => {
    expect(removedLabel(2)).toBe("2 lines removed");
  });
});
