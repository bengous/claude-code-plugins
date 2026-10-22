import { describe, expect, test } from "bun:test";

import type { Anchor, Camera, Image, Point, Space, Target } from "./machine.ts";
import { alignment, anchorOf, camera, navigate, shown } from "./machine.ts";

const ZONES = new Map([
  ["catalog", "app"],
  ["orders", "app"],
  ["db", "data"],
]);

const zoneOf = (id: string): string | null => ZONES.get(id) ?? null;

const OVERVIEW_PLACE = { zone: null, node: null } as const;

describe("navigation", () => {
  test("a brick opens its zone with the brick selected", () => {
    expect(navigate(OVERVIEW_PLACE, { type: "node", id: "orders" }, zoneOf)).toEqual({
      zone: "app",
      node: "orders",
    });
  });

  test("a service outside stays on the overview", () => {
    const place = navigate({ zone: "app", node: "catalog" }, { type: "node", id: "email" }, zoneOf);
    expect(place).toEqual({ zone: null, node: "email" });
  });

  test("back climbs one level at a time", () => {
    const brick = { zone: "app", node: "catalog" };
    const zone = navigate(brick, { type: "back" }, zoneOf);
    expect(zone).toEqual({ zone: "app", node: null });
    expect(navigate(zone, { type: "back" }, zoneOf)).toEqual(OVERVIEW_PLACE);
    expect(navigate({ zone: null, node: "email" }, { type: "back" }, zoneOf)).toEqual(
      OVERVIEW_PLACE,
    );
  });
});

// Two zones, each with a frame on the overview drawing and one on the detail
// drawing, far apart and at different scales, as engine.ts lays them out.
const ANCHORS = new Map<string, Anchor>([
  ["app", { ov: { x: 500, y: 200, w: 160, h: 150 }, dt: { x: 9000, y: 500, w: 650, h: 280 } }],
  ["data", { ov: { x: 300, y: 200, w: 170, h: 150 }, dt: { x: 8200, y: 500, w: 880, h: 300 } }],
]);

const OVERVIEW: Image = {
  space: "ov",
  vb: { x: 0, y: 0, w: 1400, h: 1000 },
  op: { ov: 1, dt: 0 },
  align: null,
};

const imageOf = (zone: string | null): Target => {
  if (zone === null) {
    return { space: "ov", vb: OVERVIEW.vb, op: { ov: 1, dt: 0 } };
  }

  const { dt } = anchorOf(ANCHORS, zone);

  return { space: "dt", vb: { ...dt, h: dt.w / 1.4 }, op: { ov: 0, dt: 1 } };
};

// Where a point of a drawing lands on screen (0..1 across the view), with the
// drawing that is not the image's space moved by the alignment, as paint() does.
const onScreen = (image: Image, drawing: Space, [x, y]: Point): Point => {
  const placed = (): Point => {
    if (drawing === image.space || image.align === null) {
      return [x, y];
    }

    const a = alignment(anchorOf(ANCHORS, image.align));
    const r = drawing === "ov" ? a.toDt({ x, y, w: 0, h: 0 }) : a.toOv({ x, y, w: 0, h: 0 });

    return [r.x, r.y];
  };

  const [px, py] = placed();

  return [(px - image.vb.x) / image.vb.w, (py - image.vb.y) / image.vb.h];
};

// The screen is the same if every visible drawing puts its points at the same place.
const expectSameScreen = (a: Image, b: Image): void => {
  const drawings: Space[] = ["ov", "dt"];

  for (const drawing of drawings) {
    expect(b.op[drawing]).toBeCloseTo(a.op[drawing], 6);

    if (a.op[drawing] === 0) {
      continue;
    }

    const points: Point[] = [
      [520, 230],
      [9100, 600],
      [0, 0],
    ];

    for (const pt of points) {
      const [ax, ay] = onScreen(a, drawing, pt);
      const [bx, by] = onScreen(b, drawing, pt);

      expect(bx).toBeCloseTo(ax, 6);
      expect(by).toBeCloseTo(ay, 6);
    }
  }
};

const IDLE: Camera = { kind: "idle", image: OVERVIEW };

const go = (cam: Camera, zone: string | null, link: string, now: number): Camera =>
  camera(cam, { type: "go", to: imageOf(zone), link, now, dur: 700 }, ANCHORS);

describe("camera", () => {
  test("entering a zone starts from the picture on screen and ends on the zone", () => {
    const cam = go(IDLE, "app", "app", 1000);
    expectSameScreen(OVERVIEW, shown(cam, 1000));
    expect(camera(cam, { type: "tick", now: 1700 }, ANCHORS)).toEqual({
      kind: "idle",
      image: { ...imageOf("app"), align: "app" },
    });
  });

  test("the levels cross-fade during the middle third only", () => {
    const cam = go(IDLE, "app", "app", 0);
    expect(shown(cam, 200).op).toEqual({ ov: 1, dt: 0 });
    const mid = shown(cam, 350).op;
    expect(mid.ov).toBeGreaterThan(0);
    expect(mid.dt).toBeGreaterThan(0);
    expect(shown(cam, 500).op).toEqual({ ov: 0, dt: 1 });
  });

  test("the zone entered stays on screen all along", () => {
    const cam = go(IDLE, "app", "app", 0);
    const [cx, cy] = [9000 + 325, 500 + 140];

    for (let t = 0; t <= 700; t += 50) {
      const [x, y] = onScreen(shown(cam, t), "dt", [cx, cy]);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
    }
  });

  test("a click during a move restarts from the picture on screen", () => {
    const entering = go(IDLE, "app", "app", 0);

    const retargets: Array<[string | null, string]> = [
      [null, "app"],
      ["data", "data"],
    ];

    for (const [zone, link] of retargets) {
      const before = shown(entering, 350);
      const retarget = go(entering, zone, link, 350);
      expectSameScreen(before, shown(retarget, 350));
    }
  });

  test("leaving a zone returns to the overview without a jump", () => {
    const inApp = { kind: "idle", image: { ...imageOf("app"), align: "app" } } as const;
    const cam = go(inApp, null, "app", 0);
    expectSameScreen(inApp.image, shown(cam, 0));
    expect(camera(cam, { type: "tick", now: 700 }, ANCHORS)).toEqual({
      kind: "idle",
      image: { ...imageOf(null), align: "app" },
    });
  });

  test("with no duration the camera lands at once", () => {
    const cam = camera(
      IDLE,
      { type: "go", to: imageOf("app"), link: "app", now: 0, dur: 0 },
      ANCHORS,
    );

    expect(cam).toEqual({ kind: "idle", image: { ...imageOf("app"), align: "app" } });
  });
});
