import { describe, expect, test } from "bun:test";

import type { Rect } from "./geometry.ts";
import { MAX_ZOOM, clamped, panned, zoomed, zoomedIn } from "./zoom.ts";

const FIT: Rect = { x: -100, y: 0, w: 1200, h: 1000 };

const aspectOf = (r: Rect): number => r.w / r.h;

describe("zoomed", () => {
  test("zooming in keeps the point under the pointer where it is, at the fit's aspect", () => {
    const at: [number, number] = [500, 250];
    const vb = zoomed(FIT, at, 0.5, FIT);

    expect(vb).toEqual({ x: 200, y: 125, w: 600, h: 500 });
    expect((at[0] - vb.x) / vb.w).toBeCloseTo((at[0] - FIT.x) / FIT.w);
    expect((at[1] - vb.y) / vb.h).toBeCloseTo((at[1] - FIT.y) / FIT.h);
    expect(aspectOf(vb)).toBeCloseTo(aspectOf(FIT));
  });

  test("zooming out stops at the fit, and zooming in at MAX_ZOOM", () => {
    expect(zoomed(FIT, [0, 0], 2, FIT)).toEqual(FIT);

    const narrowest = zoomed(FIT, [500, 500], 1 / (MAX_ZOOM * 4), FIT);
    expect(narrowest.w).toBeCloseTo(FIT.w / MAX_ZOOM);
    expect(aspectOf(narrowest)).toBeCloseTo(aspectOf(FIT));
  });

  test("a zoom near an edge slides back inside the fit", () => {
    const vb = zoomed(FIT, [-100, 0], 0.5, FIT);

    expect(vb).toEqual({ x: -100, y: 0, w: 600, h: 500 });
  });
});

describe("panned", () => {
  const half = zoomed(FIT, [500, 500], 0.5, FIT);

  test("a drag moves the rect against the pointer, and no further than the drawing", () => {
    expect(panned(half, 100, -50, FIT)).toEqual({ ...half, x: half.x - 100, y: half.y + 50 });
    expect(panned(half, 10_000, 10_000, FIT)).toEqual({ ...half, x: FIT.x, y: FIT.y });
    expect(panned(half, -10_000, -10_000, FIT)).toEqual({
      ...half,
      x: FIT.x + FIT.w - half.w,
      y: FIT.y + FIT.h - half.h,
    });
  });

  test("at the fit there is nowhere to pan", () => {
    expect(panned(FIT, 300, 300, FIT)).toEqual(FIT);
  });
});

describe("clamped and zoomedIn", () => {
  test("a rect wider than the fit or off it is brought back to the fit", () => {
    expect(clamped({ x: 0, y: 0, w: 5000, h: 10 }, FIT)).toEqual(FIT);
    expect(clamped({ x: 900, y: 900, w: 600, h: 500 }, FIT)).toEqual({
      x: 500,
      y: 500,
      w: 600,
      h: 500,
    });
  });

  test("zoomedIn tells the fit from a closer look", () => {
    expect(zoomedIn(FIT, FIT)).toBe(false);
    expect(zoomedIn(zoomed(FIT, [0, 0], 0.9, FIT), FIT)).toBe(true);
  });
});
