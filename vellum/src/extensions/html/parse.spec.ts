import { describe, expect, test } from "bun:test";

import type { FrameToPage } from "./messages.ts";
import { parseFrameToPage } from "./parse.ts";

const CARD = { selector: "section#pricing > div.card", text: "Pro, 12 € a month", label: "div" };

const BOX = { top: 40, left: 8, width: 320, height: 96 };

describe("parseFrameToPage", () => {
  test("a pick crosses with its elements and its box", () => {
    const pick: FrameToPage = { type: "vellum:pick", elements: [CARD], box: BOX };

    expect(parseFrameToPage(pick)).toEqual(pick);
  });

  test("a field the contract does not name is left behind", () => {
    const pick = { type: "vellum:pick", elements: [{ ...CARD, html: "<b>" }], box: BOX, by: "x" };

    expect(parseFrameToPage(pick)).toEqual({ type: "vellum:pick", elements: [CARD], box: BOX });
  });

  test("a pick without elements is refused: the mockup's own script can post one", () => {
    expect(parseFrameToPage({ type: "vellum:pick", box: BOX })).toBeNull();
    expect(parseFrameToPage({ type: "vellum:pick", elements: "all", box: BOX })).toBeNull();
  });

  test("one unreadable element refuses the whole pick, never half of it", () => {
    const elements = [CARD, { selector: "div.card", text: 12, label: "div" }];

    expect(parseFrameToPage({ type: "vellum:pick", elements, box: BOX })).toBeNull();
  });

  test("a box needs its four finite numbers", () => {
    const elements = [CARD];

    expect(parseFrameToPage({ type: "vellum:pick", elements })).toBeNull();
    expect(
      parseFrameToPage({ type: "vellum:pick", elements, box: { ...BOX, top: "40" } }),
    ).toBeNull();
    expect(
      parseFrameToPage({ type: "vellum:pick", elements, box: { ...BOX, left: NaN } }),
    ).toBeNull();
  });

  test("an empty pick crosses: the page reads it as no draft", () => {
    const pick: FrameToPage = { type: "vellum:pick", elements: [], box: BOX };

    expect(parseFrameToPage(pick)).toEqual(pick);
  });

  test("an unpick crosses as its type alone", () => {
    expect(parseFrameToPage({ type: "vellum:unpick", elements: [CARD] })).toEqual({
      type: "vellum:unpick",
    });
  });

  test("holding needs its boolean", () => {
    expect(parseFrameToPage({ type: "vellum:holding", holding: true })).toEqual({
      type: "vellum:holding",
      holding: true,
    });
    expect(parseFrameToPage({ type: "vellum:holding", holding: "yes" })).toBeNull();
  });

  test("what is not a message of the frame is refused", () => {
    expect(parseFrameToPage(null)).toBeNull();
    expect(parseFrameToPage("vellum:unpick")).toBeNull();
    expect(parseFrameToPage({ type: "vellum:method", method: "select" })).toBeNull();
  });
});
