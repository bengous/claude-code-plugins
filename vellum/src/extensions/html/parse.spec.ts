import { describe, expect, test } from "bun:test";

import type { FrameToPage } from "./messages.ts";
import { parseFrameToPage } from "./parse.ts";

const CARD = {
  selector: "section#pricing > div.card",
  text: "Pro, 12 € a month",
  label: "div",
  context: { prefix: "", suffix: "", repeated: false },
  description: { heading: "Plans", role: "", name: "", openingTag: '<div class="card">' },
};

const BOX = { top: 40, left: 8, width: 320, height: 96 };

describe("parseFrameToPage", () => {
  test("a pick crosses with its elements and its box", () => {
    const pick: FrameToPage = { type: "vellum:pick", elements: [CARD], box: BOX };

    expect(parseFrameToPage(pick)).toEqual(pick);
  });

  test("a field the contract does not name is left behind", () => {
    const context = { ...CARD.context, offset: 4 };
    const description = { ...CARD.description, level: 2 };
    const element = { ...CARD, html: "<b>", context, description };
    const pick = { type: "vellum:pick", elements: [element], box: BOX, by: "x" };

    expect(parseFrameToPage(pick)).toEqual({ type: "vellum:pick", elements: [CARD], box: BOX });
  });

  test("an element needs what it is: the heading before it, its role, its name, its opening tag", () => {
    const { description, ...bare } = CARD;

    const unreadable = [
      bare,
      { ...CARD, description: { ...description, name: null } },
      { ...CARD, description: { heading: "Plans", role: "", name: "" } },
    ];

    for (const element of unreadable) {
      expect(parseFrameToPage({ type: "vellum:pick", elements: [element], box: BOX })).toBeNull();
    }
  });

  test("a pick without elements is refused: the mockup's own script can post one", () => {
    expect(parseFrameToPage({ type: "vellum:pick", box: BOX })).toBeNull();
    expect(parseFrameToPage({ type: "vellum:pick", elements: "all", box: BOX })).toBeNull();
  });

  test("one unreadable element refuses the whole pick, never half of it", () => {
    const elements = [CARD, { ...CARD, text: 12 }];

    expect(parseFrameToPage({ type: "vellum:pick", elements, box: BOX })).toBeNull();
  });

  test("an element needs the context of its words: the characters around them, and whether they repeat", () => {
    const { context, ...bare } = CARD;

    const unreadable = [
      bare,
      { ...CARD, context: { ...context, repeated: "no" } },
      { ...CARD, context: { ...context, prefix: 3 } },
    ];

    for (const element of unreadable) {
      expect(parseFrameToPage({ type: "vellum:pick", elements: [element], box: BOX })).toBeNull();
    }
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

  test("a switch crosses: C was pressed inside the mockup", () => {
    const flip: FrameToPage = { type: "vellum:switch" };

    expect(parseFrameToPage(flip)).toEqual(flip);
  });

  test("a switch with fields the contract does not name crosses as its type alone", () => {
    expect(parseFrameToPage({ type: "vellum:switch", on: false, by: "x" })).toEqual({
      type: "vellum:switch",
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
    expect(parseFrameToPage({ type: "vellum:commenting", on: true })).toBeNull();
  });
});
