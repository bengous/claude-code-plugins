import { describe, expect, test } from "bun:test";

import type { Point, Rect } from "./geometry.ts";
import { center } from "./geometry.ts";
import type { Pinned } from "./trace.ts";
import {
  TRAVEL,
  bendOf,
  borderToward,
  curveOf,
  formAt,
  frameOf,
  pathOf,
  pointAt,
  repeatsOf,
  travelled,
} from "./trace.ts";
import { MAX_ZOOM } from "./zoom.ts";

const A: Rect = { x: 0, y: 0, w: 100, h: 40 };

const B: Rect = { x: 400, y: 0, w: 100, h: 40 };

const close = (p: Point, q: Point): void => {
  expect(p[0]).toBeCloseTo(q[0]);
  expect(p[1]).toBeCloseTo(q[1]);
};

describe("borderToward", () => {
  test("the point of the border on the way from the centre toward a point", () => {
    expect(borderToward(A, [500, 20])).toEqual([100, 20]);
    expect(borderToward(A, [50, -100])).toEqual([50, 0]);
    expect(borderToward(A, [150, 70])).toEqual([90, 40]);
    expect(borderToward(A, [50, 20])).toEqual([50, 20]);
  });
});

describe("bendOf", () => {
  test("a sixth of the chord, between 18 and 70, and 80 % further for each step before on the pair", () => {
    expect(bendOf(50, 0)).toBe(18);
    expect(bendOf(300, 0)).toBeCloseTo(48);
    expect(bendOf(1000, 0)).toBe(70);
    expect(bendOf(300, 1)).toBeCloseTo(48 * 1.8);
    expect(bendOf(1000, 2)).toBeCloseTo(70 * 2.6);
  });
});

describe("curveOf and pointAt", () => {
  test("from a's border toward b's centre to b's border toward a's centre", () => {
    const curve = curveOf(A, B, 0);

    expect(curve.p0).toEqual([100, 20]);
    expect(curve.p1).toEqual([400, 20]);
    close(pointAt(curve, 0), curve.p0);
    close(pointAt(curve, 1), curve.p1);
  });

  test("its control point is the chord's middle moved by the bend, square to the chord, (-dy, dx) / L", () => {
    const curve = curveOf(A, B, 0);
    const bend = bendOf(300, 0);

    close(curve.c, [250, 20 + bend]);
    close(pointAt(curve, 0.5), [250, 20 + bend / 2]);
  });

  test("a step and its return bow to either side; a second step on the same pair bows further", () => {
    const there = curveOf(A, B, 0);
    const back = curveOf(B, A, 0);
    const again = curveOf(A, B, 1);

    expect(there.c[1]).toBeGreaterThan(20);
    expect(back.c[1]).toBeLessThan(20);
    expect(again.c[1] - 20).toBeCloseTo((there.c[1] - 20) * 1.8);
  });

  test("its path is the quadratic curve, M then Q", () => {
    expect(pathOf(curveOf(A, B, 0))).toBe("M100.0 20.0 Q250.0 68.0 400.0 20.0");
  });
});

describe("repeatsOf", () => {
  test("how many steps before each have the same ordered pair", () => {
    expect(repeatsOf(["a>b", "b>a", "a>b", "a>c", "a>b"])).toEqual([0, 0, 1, 0, 2]);
  });
});

describe("travelled and formAt", () => {
  test("the pill waits 250 ms, travels 1000 ms speeding up then slowing down, and stays at the end", () => {
    expect(TRAVEL).toEqual({ delay: 250, ms: 1000 });
    expect(travelled(0)).toBe(0);
    expect(travelled(250)).toBe(0);
    expect(travelled(750)).toBeCloseTo(0.5);
    expect(travelled(1250)).toBe(1);
    expect(travelled(5000)).toBe(1);
    expect(travelled(350)).toBeLessThan(0.1);
    expect(travelled(1150)).toBeGreaterThan(0.9);
  });

  test("the first half carries the form before the step, when there is one; then the form after it", () => {
    expect(formAt("the cart", "a charge", 0.2)).toBe("the cart");
    expect(formAt("the cart", "a charge", 0.5)).toBe("a charge");
    expect(formAt(null, "a charge", 0.2)).toBe("a charge");
    expect(formAt(null, null, 0.2)).toBeNull();
  });
});

describe("frameOf", () => {
  const FIT: Rect = { x: -500, y: -500, w: 4000, h: 3000 };
  const SCREEN = { w: 800, h: 600 };

  test("its part above the ribbon holds the rects, centred, with the margin on screen", () => {
    const vb = frameOf([A, B], [], SCREEN, 0.8, 60, FIT);
    const scale = SCREEN.w / vb.w;

    expect(vb.w / vb.h).toBeCloseTo(FIT.w / FIT.h);
    expect((A.x - vb.x) * scale).toBeCloseTo(60);
    expect((vb.x + vb.w - (B.x + B.w)) * scale).toBeCloseTo(60);

    const above = vb.h * 0.8;
    close(center({ ...vb, h: above }), center({ x: 0, y: 0, w: 500, h: 40 }));
  });

  test("a frame taller than wide leaves the margin above and below", () => {
    const tall: Rect = { x: 0, y: 0, w: 40, h: 600 };
    const vb = frameOf([tall], [], SCREEN, 1, 60, FIT);
    const scale = SCREEN.h / vb.h;

    expect((tall.y - vb.y) * scale).toBeCloseTo(60);
  });

  test("a mark pinned on screen counts at its size on screen, whatever the frame's scale", () => {
    const pill: Pinned = { at: [50, 0], box: { x: -60, y: -30, w: 120, h: 24 } };
    const without = frameOf([A, B], [], SCREEN, 1, 60, FIT);
    const vb = frameOf([A, B], [pill], SCREEN, 1, 60, FIT);
    const scale = SCREEN.h / vb.h;

    expect(vb.y).toBeLessThan(without.y);
    expect((0 - vb.y) * scale).toBeGreaterThanOrEqual(30 + 60 - 1);
  });

  test("it never zooms in past MAX_ZOOM, and stays within the fit", () => {
    const dot: Rect = { x: 1000, y: 1000, w: 1, h: 1 };
    const near = frameOf([dot], [], SCREEN, 1, 60, FIT);

    expect(near.w).toBeCloseTo(FIT.w / MAX_ZOOM);
    close(center(near), [1000.5, 1000.5]);

    const wide: Rect = { x: -1000, y: -1000, w: 9000, h: 9000 };
    expect(frameOf([wide], [], SCREEN, 1, 60, FIT)).toEqual(FIT);

    const corner = frameOf([{ x: -500, y: -500, w: 10, h: 10 }], [], SCREEN, 1, 60, FIT);
    expect(corner.x).toBe(FIT.x);
    expect(corner.y).toBe(FIT.y);
  });

  test("nothing to frame: the fit", () => {
    expect(frameOf([], [], SCREEN, 1, 60, FIT)).toEqual(FIT);
  });
});
