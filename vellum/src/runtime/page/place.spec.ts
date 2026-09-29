import { describe, expect, test } from "bun:test";

import { placeNear } from "./place.ts";

const PANE = { top: 0, left: 0, width: 800, height: 600 };

const SIZE = { width: 300, height: 200 };

describe("placeNear", () => {
  test("goes under the target when the room is there, 8px off, at the target's left", () => {
    const target = { top: 100, left: 120, width: 50, height: 20 };

    expect(placeNear(target, PANE, SIZE)).toEqual({ top: 128, left: 120 });
  });

  test("goes above the target when the room under it is short", () => {
    const target = { top: 500, left: 120, width: 50, height: 20 };

    expect(placeNear(target, PANE, SIZE)).toEqual({ top: 292, left: 120 });
  });

  test("goes under all the same when neither side has the room: the pane scrolls", () => {
    const short = { top: 0, left: 0, width: 800, height: 300 };
    const target = { top: 150, left: 120, width: 50, height: 20 };

    expect(placeNear(target, short, SIZE)).toEqual({ top: 178, left: 120 });
  });

  test("never passes the pane's right edge", () => {
    const target = { top: 100, left: 700, width: 50, height: 20 };

    expect(placeNear(target, PANE, SIZE).left).toBe(492);
  });

  test("never starts before the pane's left edge", () => {
    const target = { top: 100, left: 2, width: 50, height: 20 };

    expect(placeNear(target, PANE, SIZE).left).toBe(8);
  });

  test("a scrolled pane's window counts from its scroll", () => {
    const scrolled = { top: 1000, left: 0, width: 800, height: 600 };
    const target = { top: 1500, left: 120, width: 50, height: 20 };

    expect(placeNear(target, scrolled, SIZE)).toEqual({ top: 1292, left: 120 });
  });
});
