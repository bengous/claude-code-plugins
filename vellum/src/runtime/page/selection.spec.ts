import { describe, expect, test } from "bun:test";

import type { KeyPress } from "./selection.ts";
import { isSwitchKey, nextSelection, relationOf } from "./selection.ts";

describe("nextSelection", () => {
  test("a Ctrl+click on a chosen target removes it", () => {
    expect(nextSelection(["separate", "same"])).toEqual({ keep: [0], add: false });
  });

  test("a Ctrl+click inside a chosen target replaces it", () => {
    expect(nextSelection(["overlapping"])).toEqual({ keep: [], add: true });
  });

  test("a Ctrl+click elsewhere joins the set", () => {
    expect(nextSelection(["separate"])).toEqual({ keep: [0], add: true });
  });
});

describe("relationOf", () => {
  test("the same bounds are the same place", () => {
    expect(relationOf({ startToStart: 0, startToEnd: 1, endToEnd: 0, endToStart: -1 })).toBe(
      "same",
    );
  });

  test("a place nested in another overlaps it, either way round", () => {
    expect(relationOf({ startToStart: 1, startToEnd: 1, endToEnd: -1, endToStart: -1 })).toBe(
      "overlapping",
    );
    expect(relationOf({ startToStart: -1, startToEnd: 1, endToEnd: 1, endToStart: -1 })).toBe(
      "overlapping",
    );
  });

  test("a drag over a paragraph's first words overlaps the paragraph: one start, two ends", () => {
    expect(relationOf({ startToStart: 0, startToEnd: 1, endToEnd: -1, endToStart: -1 })).toBe(
      "overlapping",
    );
  });

  test("a drag over a paragraph's last words overlaps the paragraph: two starts, one end", () => {
    expect(relationOf({ startToStart: 1, startToEnd: 1, endToEnd: 0, endToStart: -1 })).toBe(
      "overlapping",
    );
  });

  test("a place that crosses another overlaps it", () => {
    expect(relationOf({ startToStart: -1, startToEnd: 1, endToEnd: -1, endToStart: -1 })).toBe(
      "overlapping",
    );
  });

  test("a place wholly before or wholly after another is separate", () => {
    expect(relationOf({ startToStart: -1, startToEnd: -1, endToEnd: -1, endToStart: -1 })).toBe(
      "separate",
    );
    expect(relationOf({ startToStart: 1, startToEnd: 1, endToEnd: 1, endToStart: 1 })).toBe(
      "separate",
    );
  });

  test("two places that touch share no text: separate, either way round", () => {
    expect(relationOf({ startToStart: -1, startToEnd: 0, endToEnd: -1, endToStart: -1 })).toBe(
      "separate",
    );
    expect(relationOf({ startToStart: 1, startToEnd: 1, endToEnd: 1, endToStart: 0 })).toBe(
      "separate",
    );
  });
});

describe("isSwitchKey", () => {
  const c: KeyPress = {
    key: "c",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    repeat: false,
    typing: false,
    from: "sheet",
  };

  test("c and C flip the switch", () => {
    expect(isSwitchKey(c)).toBe(true);
    expect(isSwitchKey({ ...c, key: "C" })).toBe(true);
  });

  test("from the sheet or a mockup's frame it flips; from anywhere else in the page it does not", () => {
    expect(isSwitchKey({ ...c, from: "frame" })).toBe(true);
    expect(isSwitchKey({ ...c, from: "elsewhere" })).toBe(false);
  });

  test("another letter flips nothing", () => {
    expect(isSwitchKey({ ...c, key: "v" })).toBe(false);
  });

  test("with Ctrl, Meta or Alt it is another shortcut", () => {
    expect(isSwitchKey({ ...c, ctrlKey: true })).toBe(false);
    expect(isSwitchKey({ ...c, metaKey: true })).toBe(false);
    expect(isSwitchKey({ ...c, altKey: true })).toBe(false);
  });

  test("a key held down flips once: its repeats flip nothing", () => {
    expect(isSwitchKey({ ...c, repeat: true })).toBe(false);
  });

  test("typing in a field flips nothing", () => {
    expect(isSwitchKey({ ...c, typing: true })).toBe(false);
  });
});
