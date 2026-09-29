import { describe, expect, test } from "bun:test";

import { contextOf, wordsIn } from "./words.ts";

/** An element's text as its text nodes hold it: "are" at 4 and at 30. */
const TEXT = "You are offline. Your answers are saved on this tablet.";

const CLICKED = { prefix: "", suffix: "", repeated: false };

describe("contextOf", () => {
  test("the second of two same words: the characters around it, and repeated", () => {
    expect(contextOf(TEXT, 30, 33)).toEqual({
      prefix: "You are offline. Your answers ",
      suffix: " saved on this tablet.",
      repeated: true,
    });
  });

  test("words the element holds once are not repeated", () => {
    expect(contextOf(TEXT, 34, 39).repeated).toBe(false);
  });

  test("the context is collapsed as the quote is, 32 characters a side at most", () => {
    const raw = `${"x".repeat(40)}\n   Your\n\n answers   are saved ${"y".repeat(40)}`;
    const start = raw.indexOf("are");
    const { prefix, suffix } = contextOf(raw, start, start + 3);

    expect(prefix).toBe(`${"x".repeat(18)} Your answers `);
    expect(suffix).toBe(` saved ${"y".repeat(25)}`);
  });

  test("the indentation around an element's text is no context", () => {
    const raw = "\n      Save your draft. Save often.\n    ";
    const start = raw.indexOf("Save");

    expect(contextOf(raw, start, start + 4)).toEqual({
      prefix: "",
      suffix: " your draft. Save often.",
      repeated: true,
    });
  });

  test("a drag that starts or ends on whitespace quotes the words alone", () => {
    expect(contextOf(TEXT, 29, 34)).toEqual(contextOf(TEXT, 30, 33));
  });
});

describe("wordsIn", () => {
  test("the occurrence whose context fits, where the text nodes hold it", () => {
    expect(wordsIn(TEXT, "are", contextOf(TEXT, 30, 33))).toEqual([30, 33]);
    expect(wordsIn(TEXT, "are", contextOf(TEXT, 4, 7))).toEqual([4, 7]);
  });

  test("a click's empty context takes the first occurrence", () => {
    expect(wordsIn(TEXT, "are", CLICKED)).toEqual([4, 7]);
  });

  test("the same words added higher leave the mark on the ones dragged", () => {
    const rewritten = `Where are you? ${TEXT}`;

    expect(wordsIn(rewritten, "are", contextOf(TEXT, 30, 33))).toEqual([45, 48]);
  });

  test("whitespace the mockup rewrote does not lose the words", () => {
    const rewritten = "You are offline. Your\n      answers   are\n saved on this tablet.";
    const at = rewritten.lastIndexOf("are");

    expect(wordsIn(rewritten, "answers are", contextOf(TEXT, 22, 33))).toEqual([at - 10, at + 3]);
  });

  test("the dragged words gone, the same words elsewhere are not taken for them", () => {
    expect(
      wordsIn("You are offline. Your answers were kept.", "are", contextOf(TEXT, 30, 33)),
    ).toBeNull();
  });

  test("the dragged words kept beside one word of their context are still found", () => {
    const rewritten = "You are offline. Answers are kept here.";

    expect(wordsIn(rewritten, "are", contextOf(TEXT, 30, 33))).toEqual([25, 28]);
  });

  test("words the element no longer holds are nowhere", () => {
    expect(wordsIn(TEXT, "kept here", CLICKED)).toBeNull();
  });

  test("a click on an element with no text quotes nothing, which is nowhere", () => {
    expect(wordsIn(TEXT, "", CLICKED)).toBeNull();
  });
});
