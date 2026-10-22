import { describe, expect, test } from "bun:test";

import type { Anchor, Between, Camera, Image, Key, Target } from "./camera.ts";
import { betweenOf, camera, express, shown } from "./camera.ts";
import type { Point, Rect } from "./geometry.ts";
import { apply, applyRect, compose, fitting, invert } from "./geometry.ts";

// Three views, each drawn at its own origin: the root holds the box of app, whose view holds the
// box of db. A frame is where a view's boxes stand; a box is where the child stands in the parent.
const ANCHORS = new Map<string, Anchor>([
  ["app", { box: { x: 500, y: 200, w: 160, h: 150 }, frame: { x: 40, y: 40, w: 650, h: 280 } }],
  ["db", { box: { x: 420, y: 60, w: 120, h: 90 }, frame: { x: 40, y: 40, w: 300, h: 200 } }],
]);

const CHAINS = new Map<Key, readonly string[]>([
  [null, []],
  ["app", ["app"]],
  ["db", ["app", "db"]],
]);

const between: Between = betweenOf({
  chainOf: (key) => CHAINS.get(key) ?? [],
  anchorOf: (id) => {
    const anchor = ANCHORS.get(id);

    if (anchor === undefined) {
      throw new Error(`no anchor ${id}`);
    }

    return anchor;
  },
});

const SIZES = new Map<Key, Rect>([
  [null, { x: 0, y: 0, w: 1400, h: 1000 }],
  ["app", { x: 0, y: 0, w: 800, h: 360 }],
  ["db", { x: 0, y: 0, w: 400, h: 280 }],
]);

const imageOf = (space: Key): Target => {
  const size = SIZES.get(space);

  if (size === undefined) {
    throw new Error(`no view ${String(space)}`);
  }

  return { space, vb: size };
};

const at = (space: Key): Image => ({ ...imageOf(space), op: 1, other: null });

// Where a point of a view lands on screen (0..1 across the view), the other layer moved by the
// alignment, as paint() does; null when that view is not shown.
const onScreen = (image: Image, drawing: Key, pt: Point): Point | null => {
  const placed = (): Point | null => {
    if (drawing === image.space) {
      return pt;
    }

    return image.other?.space === drawing ? apply(between(drawing, image.space), pt) : null;
  };

  const p = placed();

  return p === null ? null : [(p[0] - image.vb.x) / image.vb.w, (p[1] - image.vb.y) / image.vb.h];
};

const opacityOf = (image: Image, drawing: Key): number =>
  drawing === image.space ? image.op : image.other?.space === drawing ? image.other.op : 0;

// The screen is the same if every visible drawing puts its points at the same place.
const expectSameScreen = (a: Image, b: Image): void => {
  for (const drawing of CHAINS.keys()) {
    expect(opacityOf(b, drawing)).toBeCloseTo(opacityOf(a, drawing), 6);

    if (opacityOf(a, drawing) === 0) {
      continue;
    }

    const points: Point[] = [
      [520, 230],
      [100, 60],
      [0, 0],
    ];

    for (const pt of points) {
      const expected = onScreen(a, drawing, pt);
      const got = onScreen(b, drawing, pt);

      expect(expected).not.toBeNull();
      expect(got).not.toBeNull();
      expect(got?.[0]).toBeCloseTo(expected?.[0] ?? Number.NaN, 6);
      expect(got?.[1]).toBeCloseTo(expected?.[1] ?? Number.NaN, 6);
    }
  }
};

const IDLE: Camera = { kind: "idle", image: at(null) };

const go = (cam: Camera, space: Key, now: number, dur = 700): Camera =>
  camera(cam, { type: "go", to: imageOf(space), now, dur }, between);

describe("betweenOf", () => {
  test("a view's frame lands in its box in the parent's view, centred", () => {
    const anchor = ANCHORS.get("app");
    const landed = applyRect(between("app", null), anchor?.frame ?? { x: 0, y: 0, w: 1, h: 1 });

    expect(landed.w).toBeCloseTo(160, 6);
    expect(landed.h).toBeCloseTo((280 * 160) / 650, 6);
    expect(landed.x).toBeCloseTo(500, 6);
    expect(landed.y + landed.h / 2).toBeCloseTo(275, 6);
  });

  test("two levels compose, both ways round, and a view maps onto itself as it is", () => {
    const app = ANCHORS.get("app");
    const db = ANCHORS.get("db");

    if (app === undefined || db === undefined) {
      throw new Error("anchors");
    }

    const expected = compose(fitting(db.frame, db.box), fitting(app.frame, app.box));

    expect(between("db", null)).toEqual(expected);
    expect(between(null, "db")).toEqual(invert(expected));
    expect(between("app", "app")).toEqual({ k: 1, dx: 0, dy: 0 });

    const [x, y] = apply(between("db", "app"), [190, 140]);

    expect(x).toBeCloseTo(480, 6);
    expect(y).toBeCloseTo(105, 6);
  });
});

describe("camera", () => {
  test("entering a view starts from the picture on screen and ends on the view", () => {
    const cam = go(IDLE, "app", 1000);
    expectSameScreen(at(null), shown(cam, 1000));
    expect(camera(cam, { type: "tick", now: 1700 }, between)).toEqual({
      kind: "idle",
      image: { ...imageOf("app"), op: 1, other: { space: null, op: 0 } },
    });
  });

  test("the views cross-fade during the middle third only", () => {
    const cam = go(IDLE, "app", 0);
    expect([opacityOf(shown(cam, 200), null), opacityOf(shown(cam, 200), "app")]).toEqual([1, 0]);
    const mid = shown(cam, 350);
    expect(opacityOf(mid, null)).toBeGreaterThan(0);
    expect(opacityOf(mid, "app")).toBeGreaterThan(0);
    expect([opacityOf(shown(cam, 500), null), opacityOf(shown(cam, 500), "app")]).toEqual([0, 1]);
  });

  test("the view entered stays on screen all along", () => {
    const cam = go(IDLE, "app", 0);
    const [cx, cy] = [40 + 325, 40 + 140];

    for (let t = 0; t <= 700; t += 50) {
      const point = onScreen(shown(cam, t), "app", [cx, cy]);

      expect(point).not.toBeNull();

      for (const u of point ?? []) {
        expect(u).toBeGreaterThanOrEqual(0);
        expect(u).toBeLessThanOrEqual(1);
      }
    }
  });

  test("a click during a move restarts from the picture on screen", () => {
    const entering = go(IDLE, "app", 0);

    for (const space of [null, "app"]) {
      const before = shown(entering, 350);
      const retarget = go(entering, space, 350);
      expectSameScreen(before, shown(retarget, 350));
    }
  });

  test("a third view during a move starts from the layer that shows most, alone", () => {
    const entering = go(IDLE, "app", 0);
    const early = shown(entering, 300);
    const late = shown(entering, 400);

    expect(opacityOf(early, null)).toBeGreaterThan(opacityOf(early, "app"));
    expect(opacityOf(late, "app")).toBeGreaterThan(opacityOf(late, null));

    const fromRoot = express(early, "db", between);
    const fromApp = express(late, "db", between);

    expect(fromRoot).toMatchObject({ space: "db", op: 0, other: { space: null, op: 1 } });
    expect(fromApp).toMatchObject({ space: "db", op: 0, other: { space: "app", op: 1 } });

    const kept = onScreen({ ...early, op: 0, other: { space: null, op: 1 } }, null, [520, 230]);
    const got = onScreen(fromRoot, null, [520, 230]);

    expect(got?.[0]).toBeCloseTo(kept?.[0] ?? Number.NaN, 6);
    expect(got?.[1]).toBeCloseTo(kept?.[1] ?? Number.NaN, 6);
  });

  test("leaving a view returns to its parent without a jump", () => {
    const inApp: Camera = { kind: "idle", image: at("app") };
    const cam = go(inApp, null, 0);
    expectSameScreen(inApp.image, shown(cam, 0));
    expect(camera(cam, { type: "tick", now: 700 }, between)).toEqual({
      kind: "idle",
      image: { ...imageOf(null), op: 1, other: { space: "app", op: 0 } },
    });
  });

  test("the pivot is the centre of the smaller frame: the view entered, or the one left", () => {
    const entering = go(IDLE, "db", 0);
    const leaving = go({ kind: "idle", image: at("db") }, null, 0);

    expect(entering.kind === "moving" ? entering.pivot : null).toEqual([200, 140]);

    const [x, y] = apply(between("db", null), [200, 140]);

    expect(leaving.kind === "moving" ? leaving.pivot[0] : null).toBeCloseTo(x, 6);
    expect(leaving.kind === "moving" ? leaving.pivot[1] : null).toBeCloseTo(y, 6);
  });

  test("with no duration the camera lands at once", () => {
    expect(go(IDLE, "app", 0, 0)).toEqual({
      kind: "idle",
      image: { ...imageOf("app"), op: 1, other: { space: null, op: 0 } },
    });
  });

  test("a jump shows the image as given", () => {
    const image = at("db");

    expect(camera(go(IDLE, "app", 0), { type: "jump", image }, between)).toEqual({
      kind: "idle",
      image,
    });
  });
});
