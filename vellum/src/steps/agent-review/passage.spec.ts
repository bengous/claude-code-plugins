import { describe, expect, test } from "bun:test";

import { passageOf } from "./passage.ts";

function version(lines: Record<number, string>, length = 30): string {
  return Array.from({ length }, (_, index) => lines[index + 1] ?? `filler ${index + 1}`).join("\n");
}

describe("passageOf", () => {
  test("a quote found in its lines is a whole passage, its context the rendered text", () => {
    const text = "# Plan\n\n## Slices\n\n1. Wire the parser into the page, then test it.\n";

    expect(passageOf(text, { lines: [5, 5], quote: "the parser into the page" })).toEqual({
      kind: "prose",
      quote: "the parser into the page",
      prefix: "Plan\nSlices\n\nWire ",
      suffix: ", then test it.\n",
      lines: [5, 5],
      removed: false,
    });
  });

  test("a quote absent from the text is no passage", () => {
    const text = version({ 12: "Wire the parser into the page." });

    expect(passageOf(text, { lines: [12, 12], quote: "wire the reader" })).toBeNull();
  });

  test("a range off by a few lines still finds the quote, and gives its real line", () => {
    const text = version({ 15: "Wire the parser into the page." });

    expect(passageOf(text, { lines: [12, 12], quote: "the parser" })?.lines).toEqual([15, 15]);
  });

  test("a quote far from its range is no passage", () => {
    const text = version({ 28: "Wire the parser into the page." });

    expect(passageOf(text, { lines: [3, 4], quote: "the parser" })).toBeNull();
  });

  test("a repeated quote is the occurrence nearest its range", () => {
    const text = version({ 4: "Run the check.", 20: "Run the check.", 26: "Run the check." });

    expect(passageOf(text, { lines: [21, 22], quote: "Run the check" })?.lines).toEqual([20, 20]);
  });

  test("a quote carrying inline markup is no passage: the page shows no markup", () => {
    const text = version({ 9: "Call `parseVerdict` on **every** _big_ [file](a.md)." });

    expect(passageOf(text, { lines: [9, 9], quote: "Call `parseVerdict`" })).toBeNull();
    expect(passageOf(text, { lines: [9, 9], quote: "on **every**" })).toBeNull();
    expect(passageOf(text, { lines: [9, 9], quote: "_big_" })).toBeNull();
    expect(passageOf(text, { lines: [9, 9], quote: "[file](a.md)" })).toBeNull();
  });

  test("words read on the page across markup are found on their source line", () => {
    const text = version({ 9: "Call `parseVerdict` on **every** file." });

    expect(passageOf(text, { lines: [9, 9], quote: "parseVerdict on every file" })?.lines).toEqual([
      9, 9,
    ]);
  });

  test("a heading or list marker is no passage, the words after it are", () => {
    const text = "## Slices\n\n- Wire the parser\n";

    expect(passageOf(text, { lines: [1, 1], quote: "## Slices" })).toBeNull();
    expect(passageOf(text, { lines: [3, 3], quote: "- Wire the" })).toBeNull();
    expect(passageOf(text, { lines: [3, 3], quote: "Wire the" })?.lines).toEqual([3, 3]);
  });

  test("a link target and a diagram's source are no passage: the page shows neither", () => {
    const text = "- see [docs](docs/a.md) here\n\n```mermaid\ngraph TD\n  A --> B\n```\n";

    expect(passageOf(text, { lines: [1, 1], quote: "docs/a.md" })).toBeNull();
    expect(passageOf(text, { lines: [5, 5], quote: "A --> B" })).toBeNull();
  });

  test("a code block's text is quoted as it stands, a code passage on its own line", () => {
    const text = "Run:\n\n```bash\nbun test **/*.spec.ts\n```\n";

    expect(passageOf(text, { lines: [4, 4], quote: "**/*.spec.ts" })).toMatchObject({
      kind: "code",
      lines: [4, 4],
    });
  });

  test("a character outside the BMP before the quote leaves its line where it is", () => {
    const text = "🚀🚀🚀🚀 launch\nRun\nmore\n";

    expect(passageOf(text, { lines: [2, 2], quote: "Run" })?.lines).toEqual([2, 2]);
  });

  test("a quote over two list items with their marker is no passage", () => {
    const text = version({ 9: "- first item", 10: "- second item" });

    expect(passageOf(text, { lines: [9, 10], quote: "first item\n- second" })).toBeNull();
  });
});
