import { describe, expect, test } from "bun:test";

import type { Rect } from "./geometry.ts";
import {
  MAX_ZOOM,
  MIN_CAPTION_PX,
  captionShown,
  clamped,
  edgePush,
  panned,
  pushed,
  zoomed,
  zoomedIn,
} from "./zoom.ts";

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

describe("edgePush and pushed", () => {
  const BOX: Rect = { x: 100, y: 50, w: 800, h: 600 };

  test("the pointer pushes toward the edge it nears, harder at the edge", () => {
    expect(edgePush([500, 350], BOX, 50)).toEqual([0, 0]);
    expect(edgePush([100, 350], BOX, 50)).toEqual([-1, 0]);
    expect(edgePush([875, 350], BOX, 50)).toEqual([0.5, 0]);
    expect(edgePush([900, 650], BOX, 50)).toEqual([1, 1]);
    expect(edgePush([500, 75], BOX, 50)).toEqual([0, -0.5]);
  });

  test("a pointer outside the box pushes nowhere", () => {
    expect(edgePush([50, 350], BOX, 50)).toEqual([0, 0]);
    expect(edgePush([500, 700], BOX, 50)).toEqual([0, 0]);
  });

  const half = zoomed(FIT, [500, 500], 0.5, FIT);

  test("a push slides the rect its way, a half press half as far, and keeps its size", () => {
    expect(pushed(half, [1, 0], 40, FIT)).toEqual({ ...half, x: half.x + 40 });
    expect(pushed(half, [-0.5, 1], 40, FIT)).toEqual({ ...half, x: half.x - 20, y: half.y + 40 });
  });

  test("a push stops at the drawing's edge, and at the fit there is nowhere to slide", () => {
    expect(pushed(half, [1, 1], 10_000, FIT)).toEqual({
      ...half,
      x: FIT.x + FIT.w - half.w,
      y: FIT.y + FIT.h - half.h,
    });
    expect(pushed(FIT, [1, 1], 300, FIT)).toEqual(FIT);
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

describe("captionShown", () => {
  test("a caption under the threshold on screen hides, at or over it shows", () => {
    expect(MIN_CAPTION_PX).toBe(10);
    expect(captionShown(14, 0.7, false, false)).toBe(false);
    expect(captionShown(20, 0.5, false, false)).toBe(true);
    expect(captionShown(11, 1, false, false)).toBe(true);
  });

  test("a caption under the threshold shows while its arrow is lit or hot", () => {
    expect(captionShown(14, 0.5, true, false)).toBe(true);
    expect(captionShown(14, 0.5, false, true)).toBe(true);
    expect(captionShown(14, 0.5, true, true)).toBe(true);
  });

  test("zooming in past a caption's threshold shows it, whatever its arrow", () => {
    const fitted = 0.6;
    const closer = fitted * 1.25;

    expect(captionShown(14, fitted, false, false)).toBe(false);
    expect(captionShown(14, closer, false, false)).toBe(true);
    expect(captionShown(13, closer, false, false)).toBe(false);
    expect(captionShown(13, closer * 1.1, false, false)).toBe(true);
  });
});
