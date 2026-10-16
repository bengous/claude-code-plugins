import { expect, test } from "bun:test";

import { baseOf, DEFAULT_LABELS, labelsFrom, pinnedFrom, pointingFrom } from "./config.ts";
import { composerSpot, pinnedSpot } from "./view.ts";

test("labelsFrom: the defaults when absent, none when empty, each decoded", () => {
  expect(labelsFrom(undefined)).toEqual(DEFAULT_LABELS);
  expect(labelsFrom("")).toEqual([]);
  expect(labelsFrom("Trop%20gros,%C3%80%20revoir%2C%20vite")).toEqual([
    "Trop gros",
    "À revoir, vite",
  ]);
});

test("baseOf: the server's address for the page, off the overlay's URL", () => {
  expect(baseOf("http://127.0.0.1:4242/t/tok/overlay.js")).toBe("http://127.0.0.1:4242/t/tok/");
});

test("pointingFrom: on only when the tab kept on, off when it kept nothing or garbage", () => {
  expect(pointingFrom("on")).toBe(true);
  expect(pointingFrom("off")).toBe(false);
  expect(pointingFrom(null)).toBe(false);
  expect(pointingFrom("")).toBe(false);
  expect(pointingFrom("true")).toBe(false);
  expect(pointingFrom('{"kind":"on"}')).toBe(false);
});

test("pinnedFrom: the spot the tab kept, unpinned when it kept nothing or garbage", () => {
  expect(pinnedFrom("12.5,340")).toEqual({ x: 12.5, y: 340 });
  expect(pinnedFrom("-20,4000")).toEqual({ x: -20, y: 4000 });
  expect(pinnedFrom(null)).toBeNull();
  expect(pinnedFrom("")).toBeNull();
  expect(pinnedFrom("12")).toBeNull();
  expect(pinnedFrom("12,340,5")).toBeNull();
  expect(pinnedFrom("12, 340")).toBeNull();
  expect(pinnedFrom("x,340")).toBeNull();
  expect(pinnedFrom("1e3,340")).toBeNull();
  expect(pinnedFrom("NaN,340")).toBeNull();
  expect(pinnedFrom('{"x":12,"y":340}')).toBeNull();
});

test("pinnedSpot: the pinned spot when the whole composer fits there", () => {
  expect(
    pinnedSpot({ x: 300, y: 500 }, { width: 340, height: 210 }, { width: 1000, height: 800 }),
  ).toEqual({ x: 300, y: 500 });
});

test("pinnedSpot: a spot from a bigger window, or off the edges, moves back inside", () => {
  const size = { width: 340, height: 210 };

  expect(pinnedSpot({ x: 1500, y: 1100 }, size, { width: 1000, height: 800 })).toEqual({
    x: 652,
    y: 582,
  });
  expect(pinnedSpot({ x: -40, y: -10 }, size, { width: 1000, height: 800 })).toEqual({
    x: 8,
    y: 8,
  });
  expect(pinnedSpot({ x: 300, y: 500 }, size, { width: 200, height: 150 })).toEqual({
    x: 8,
    y: 8,
  });
});

test("composerSpot: beside the target, right then left, inside the viewport", () => {
  const viewport = { width: 1000, height: 800 };

  expect(composerSpot({ x: 100, y: 100, width: 50, height: 20 }, viewport)).toEqual({
    x: 158,
    y: 100,
  });
  expect(composerSpot({ x: 900, y: 700, width: 50, height: 20 }, viewport)).toEqual({
    x: 552,
    y: 602,
  });
});

test("composerSpot: a target as wide as the viewport gets it below, else above", () => {
  const viewport = { width: 1000, height: 800 };

  expect(composerSpot({ x: 0, y: 100, width: 1000, height: 20 }, viewport)).toEqual({
    x: 8,
    y: 128,
  });
  expect(composerSpot({ x: 0, y: 700, width: 1000, height: 40 }, viewport)).toEqual({
    x: 8,
    y: 502,
  });
});
