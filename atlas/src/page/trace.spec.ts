import { describe, expect, test } from "bun:test";

import type { Point, Rect } from "./geometry.ts";
import { center } from "./geometry.ts";
import type { Copies } from "./placement.ts";
import type { Pinned } from "./trace.ts";
import {
  TRAVEL,
  bendOf,
  borderToward,
  coursesOf,
  curveOf,
  formAt,
  frameOf,
  headOf,
  headPx,
  lengthOf,
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

describe("coursesOf", () => {
  // X drawn twice, as an outside leaf on both sides at the root: its "in" copy on the left, where
  // its arrows leave, its "out" copy on the right, where they arrive; a3 in the middle.
  const X_IN: Rect = { x: 177, y: 300, w: 121, h: 52 };
  const X_OUT: Rect = { x: 1229, y: 300, w: 121, h: 52 };
  const A3: Rect = { x: 600, y: 300, w: 150, h: 60 };

  const copies = new Map<string, Copies>([
    ["X", { in: X_IN, out: X_OUT }],
    ["a3", { in: A3, out: A3 }],
  ]);

  const copiesOf = (id: string): Copies | undefined => copies.get(id);

  test("a step forward reaches the copy of an item drawn twice its arrows reach, and leaves the one they leave", () => {
    const [to, from] = coursesOf(
      [
        { from: "a3", to: "X", back: false },
        { from: "X", to: "a3", back: false },
      ],
      copiesOf,
    );

    expect(to?.b).toBe(X_OUT);
    expect(to?.curve.p1[0]).toBe(X_OUT.x);
    expect(from?.a).toBe(X_IN);
    expect(from?.curve.p0[0]).toBe(X_IN.x + X_IN.w);
  });

  test("a step back leaves the copy the arrows reach, and reaches the one they leave", () => {
    const [back, toward] = coursesOf(
      [
        { from: "X", to: "a3", back: true },
        { from: "a3", to: "X", back: true },
      ],
      copiesOf,
    );

    expect(back?.a).toBe(X_OUT);
    expect(toward?.b).toBe(X_IN);
  });

  test("a second step on the same ordered pair bows further; one with an end of no copy is null", () => {
    const [first, again, none] = coursesOf(
      [
        { from: "a3", to: "X", back: false },
        { from: "a3", to: "X", back: false },
        { from: "a3", to: "nowhere", back: false },
      ],
      copiesOf,
    );

    expect(again?.curve).toEqual(curveOf(A3, X_OUT, 1));
    expect(first?.curve).toEqual(curveOf(A3, X_OUT, 0));
    expect(none).toBeNull();
  });
});

describe("headOf, lengthOf and headPx", () => {
  test("the head stands at the curve's end, turned along its way in", () => {
    const head = headOf(curveOf(A, B, 0));
    const bend = bendOf(300, 0);

    expect(head.at).toEqual([400, 20]);
    expect(head.angle).toBeCloseTo((Math.atan2(-bend, 150) * 180) / Math.PI);
    expect(headOf({ p0: [0, 0], c: [10, 0], p1: [10, 0] }).angle).toBe(0);
  });

  test("a straight curve's length is its chord; a bowed one's is longer", () => {
    expect(lengthOf({ p0: [0, 0], c: [50, 0], p1: [100, 0] })).toBeCloseTo(100);
    expect(lengthOf(curveOf(A, B, 0))).toBeGreaterThan(300);
  });

  test("the head keeps its length on screen whatever the zoom, but never runs past its curve on screen", () => {
    expect(headPx(10, 300, 0.5)).toBe(10);
    expect(headPx(10, 300, 4)).toBe(10);
    expect(headPx(10, 9, 0.6)).toBeCloseTo(5.4);
    expect(headPx(10, 9, 6.8)).toBe(10);
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

  test("the first half carries the form before the step; then the form after it", () => {
    expect(formAt("the cart", "a charge", 0.2)).toBe("the cart");
    expect(formAt("the cart", "a charge", 0.5)).toBe("a charge");
    expect(formAt("the cart", "a charge", 1)).toBe("a charge");
  });

  test("without a form before the step, the dot travels alone in the first half, then carries the form after it", () => {
    expect(formAt(null, "the cart", 0)).toBeNull();
    expect(formAt(null, "the cart", 0.49)).toBeNull();
    expect(formAt(null, "the cart", 0.5)).toBe("the cart");
    expect(formAt(null, null, 0.8)).toBeNull();
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
