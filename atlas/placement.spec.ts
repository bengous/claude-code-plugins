import { describe, expect, test } from "bun:test";

import type { Point, Rect } from "./geometry.ts";
import { hits } from "./geometry.ts";
import { column, copyOf, labelSpots, realId, spotsOf, wrap } from "./placement.ts";

describe("copies", () => {
  test("an item drawn twice names its right copy, which arrows arrive at", () => {
    expect(copyOf("x", true, true)).toBe("x~out");
    expect(copyOf("x", true, false)).toBe("x");
    expect(copyOf("x", false, true)).toBe("x");
    expect(realId("x~out")).toBe("x");
    expect(realId("x")).toBe("x");
  });
});

const PLACED = new Map<string, Rect>([
  ["app", { x: 300, y: 100, w: 200, h: 100 }],
  ["data", { x: 300, y: 400, w: 200, h: 100 }],
]);

describe("column", () => {
  const partners = new Map<string, readonly string[]>([
    ["near-data", ["data"]],
    ["near-app", ["app"]],
    ["alone", []],
    ["mate", ["near-app"]],
  ]);

  const blocks = [
    { id: "near-data", w: 80, h: 50 },
    { id: "alone", w: 60, h: 50 },
    { id: "near-app", w: 90, h: 50 },
    { id: "mate", w: 70, h: 50 },
  ];

  const rects = column(blocks, (id) => partners.get(id) ?? [], PLACED, 100, true);

  test("blocks sit by the centre of the boxes they talk to, right-aligned on x", () => {
    expect(rects.get("near-app")).toEqual({ x: 10, y: 125, w: 90, h: 50 });
    expect(rects.get("near-data")).toEqual({ x: 20, y: 425, w: 80, h: 50 });
  });

  test("a block talking to none goes after its column-mate, or last, below the one above", () => {
    expect(rects.get("mate")).toEqual({ x: 30, y: 125 + 50 + 44, w: 70, h: 50 });
    expect(rects.get("alone")).toEqual({ x: 40, y: 425 + 50 + 44, w: 60, h: 50 });
  });

  test("a column of blocks talking to nothing placed starts at the top, finite", () => {
    const lonely = column(
      [
        { id: "a", w: 10, h: 20 },
        { id: "b", w: 10, h: 30 },
      ],
      () => [],
      new Map(),
      0,
      false,
    );

    expect(lonely.get("a")).toEqual({ x: 0, y: 0, w: 10, h: 20 });
    expect(lonely.get("b")).toEqual({ x: 0, y: 64, w: 10, h: 30 });
  });

  test("two blocks wishing the same height never overlap", () => {
    const twins = column(
      [
        { id: "a", w: 10, h: 40 },
        { id: "b", w: 10, h: 40 },
      ],
      () => ["app"],
      PLACED,
      0,
      false,
    );

    expect(twins.get("a")).toEqual({ x: 0, y: 130, w: 10, h: 40 });
    expect(twins.get("b")).toEqual({ x: 0, y: 214, w: 10, h: 40 });
  });
});

describe("wrap", () => {
  test("cells fill a row up to the target, then start the next", () => {
    expect(wrap([50, 50, 50], 120, 10, 30)).toEqual({
      cells: [
        { x: 0, y: 0, w: 50 },
        { x: 60, y: 0, w: 50 },
        { x: 0, y: 40, w: 50 },
      ],
      w: 110,
      h: 70,
    });
  });

  test("a cell wider than the target takes a row of its own; none makes an empty block", () => {
    expect(wrap([200, 10], 100, 5, 20)).toEqual({
      cells: [
        { x: 0, y: 0, w: 200 },
        { x: 0, y: 25, w: 10 },
      ],
      w: 200,
      h: 45,
    });

    expect(wrap([], 100, 5, 20)).toEqual({ cells: [], w: 0, h: 0 });
  });
});

const FLAT: Point[] = [
  [0, 100],
  [300, 100],
];

const BENT: Point[] = [
  [0, 0],
  [0, 50],
  [400, 50],
];

describe("spotsOf", () => {
  test("a flat segment offers a spot above and one below its middle first", () => {
    const [above, below] = spotsOf(FLAT, { w: 40, h: 10 });

    expect(above).toEqual({ x: 130, y: 87, w: 40, h: 10 });
    expect(below).toEqual({ x: 130, y: 103, w: 40, h: 10 });
  });

  test("the longest segment comes first, an upright one offers right and left", () => {
    const spots = spotsOf(BENT, { w: 40, h: 10 });

    expect(spots.slice(0, 2)).toEqual([
      { x: 180, y: 37, w: 40, h: 10 },
      { x: 180, y: 53, w: 40, h: 10 },
    ]);

    expect(spots).toContainEqual({ x: 6, y: 20, w: 40, h: 10 });
    expect(spots).toContainEqual({ x: -46, y: 20, w: 40, h: 10 });
  });
});

const SIZE = { w: 40, h: 10 };

describe("labelSpots", () => {
  test("a label avoids the obstacles, the labels placed before it and the other arrows", () => {
    const above: Point[] = [
      [0, 87],
      [300, 87],
    ];

    const routes = [FLAT, FLAT, above];
    const sizes = [[SIZE], [SIZE], [SIZE]];
    const obstacle: Rect = { x: 120, y: 60, w: 60, h: 30 };
    const [first, second] = labelSpots(routes.slice(0, 2), sizes.slice(0, 2), [obstacle]);

    expect(first).toEqual({ spot: { x: 130, y: 103, w: 40, h: 10 }, variant: 0 });
    expect(second).not.toBeNull();
    expect(hits(second?.spot ?? obstacle, first?.spot ?? obstacle)).toBe(false);
    expect(hits(second?.spot ?? obstacle, obstacle)).toBe(false);

    const [crowded] = labelSpots(routes, sizes, [obstacle]);
    expect(crowded?.spot).not.toEqual({ x: 130, y: 87, w: 40, h: 10 });
  });

  test("an arrow without a route or without a variant gets no spot", () => {
    expect(labelSpots([null, FLAT], [[SIZE], []], [])).toEqual([null, null]);
  });

  // A ceiling and a floor leave a label nowhere to slide to above or below the walls.
  const CEILING: Rect = { x: -1000, y: -1000, w: 3000, h: 1060 };

  const FLOOR: Rect = { x: -1000, y: 140, w: 3000, h: 1000 };

  test("a shorter variant takes a free spot the fullest one cannot", () => {
    const walls: Rect[] = [
      { x: 0, y: 70, w: 110, h: 60 },
      { x: 190, y: 70, w: 110, h: 60 },
    ];

    const [spotted] = labelSpots(
      [FLAT],
      [
        [
          { w: 120, h: 10 },
          { w: 60, h: 10 },
        ],
      ],
      [...walls, CEILING, FLOOR],
    );

    expect(spotted).toEqual({ spot: { x: 120, y: 87, w: 60, h: 10 }, variant: 1 });
  });

  test("a label wider than the gap between two items floats above them, whole", () => {
    const left: Rect = { x: 0, y: 70, w: 120, h: 60 };
    const right: Rect = { x: 180, y: 70, w: 120, h: 60 };

    const gap: Point[] = [
      [120, 100],
      [180, 100],
    ];

    const [spotted] = labelSpots(
      [gap],
      [
        [
          { w: 100, h: 10 },
          { w: 20, h: 10 },
        ],
      ],
      [left, right],
    );

    expect(spotted).toEqual({ spot: { x: 100, y: 57, w: 100, h: 10 }, variant: 0 });
  });

  test("with no free spot for any variant, the shortest one overlaps the least", () => {
    const left: Rect = { x: 0, y: 60, w: 160, h: 80 };
    const rightEdge: Rect = { x: 160, y: 60, w: 140, h: 80 };

    const [spotted] = labelSpots(
      [FLAT],
      [[SIZE, { w: 20, h: 10 }]],
      [left, rightEdge, CEILING, FLOOR],
    );

    expect(spotted?.variant).toBe(1);
    expect(spotted?.spot.w).toBe(20);
  });

  test("the least overlapping spot wins over the first one", () => {
    const mostly: Rect = { x: 0, y: 70, w: 250, h: 60 };
    const [spotted] = labelSpots([FLAT], [[SIZE]], [mostly, CEILING, FLOOR]);

    expect(spotted?.spot.x).toBeGreaterThan(200);
  });

  test("a label slides above a universal obstacle rather than over it", () => {
    const everywhere: Rect = { x: -1000, y: -1000, w: 3000, h: 3000 };
    const [above] = labelSpots([FLAT], [[SIZE]], [everywhere]);

    expect(above).toEqual({ spot: { x: 130, y: -1013, w: 40, h: 10 }, variant: 0 });
  });
});
