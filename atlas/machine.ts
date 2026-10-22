// The plan's two state machines, pure (no DOM, no clock): engine.ts feeds
// them events and paints what they return; machine.test.ts runs them.
//
// Navigation: where the reader stands (Place). It alone decides the panel,
// the breadcrumb, the highlights and where the camera goes; there is no free
// zoom or drag. A service outside the server belongs to the overview: it has
// no zone to frame.
//
// Camera: what the screen shows, as an Image. The two drawings live at
// different coordinates; while both show, the drawing that is not the
// image's space is scaled and moved so that its frame of the `align` zone
// wraps the other drawing's frame of it, centred (alignment). Without this,
// switching level showed an empty sheet between them. A move started while
// another runs starts from the image shown at that moment: the screen never
// jumps.

export type Place = { readonly zone: string | null; readonly node: string | null };

export type NavEvent =
  | { readonly type: "home" }
  | { readonly type: "back" }
  | { readonly type: "zone"; readonly id: string }
  | { readonly type: "node"; readonly id: string };

export type Rect = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

export type Point = readonly [number, number];

export type Space = "ov" | "dt";

export type Opacity = { readonly ov: number; readonly dt: number };

export type Image = {
  readonly space: Space;
  readonly vb: Rect;
  readonly op: Opacity;
  readonly align: string | null;
};

export type Target = Omit<Image, "align">;

// What the camera frames for one zone on each drawing.
export type Anchor = { readonly ov: Rect; readonly dt: Rect };

export type Anchors = ReadonlyMap<string, Anchor>;

export type Camera =
  | { readonly kind: "idle"; readonly image: Image }
  | {
      readonly kind: "moving";
      readonly from: Image;
      readonly to: Image;
      readonly pivot: Point;
      readonly t0: number;
      readonly dur: number;
    };

// go: link is the zone to align on when the move switches drawings, the zone
// entered or left; null when the move stays on one drawing.
export type CameraEvent =
  | { readonly type: "jump"; readonly image: Image }
  | { readonly type: "tick"; readonly now: number }
  | {
      readonly type: "go";
      readonly to: Target;
      readonly link: string | null;
      readonly now: number;
      readonly dur: number;
    };

export type Alignment = {
  readonly k: number;
  readonly oc: Point;
  readonly dc: Point;
  readonly toDt: (r: Rect) => Rect;
  readonly toOv: (r: Rect) => Rect;
};

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const center = (r: Rect): Point => [r.x + r.w / 2, r.y + r.h / 2];

// zoneOf(id): the zone of a brick, null for a service outside.
export function navigate(place: Place, ev: NavEvent, zoneOf: (id: string) => string | null): Place {
  switch (ev.type) {
    case "home": {
      return { zone: null, node: null };
    }

    case "zone": {
      return { zone: ev.id, node: null };
    }

    case "node": {
      return { zone: zoneOf(ev.id), node: ev.id };
    }

    case "back": {
      return place.zone !== null && place.node !== null
        ? { zone: place.zone, node: null }
        : { zone: null, node: null };
    }

    default: {
      const unknown: never = ev;

      return unknown;
    }
  }
}

export function anchorOf(anchors: Anchors, zone: string): Anchor {
  const anchor = anchors.get(zone);

  if (anchor === undefined) {
    throw new Error(`camera: no anchor for zone ${zone}`);
  }

  return anchor;
}

// Maps one drawing onto the other for one zone. The scale is the larger of
// the two ratios, so the overview's frame wraps the detail's frame.
export function alignment({ ov, dt }: Anchor): Alignment {
  const k = Math.max(dt.w / ov.w, dt.h / ov.h);
  const [ox, oy] = center(ov);
  const [dx, dy] = center(dt);

  return {
    k,
    oc: [ox, oy],
    dc: [dx, dy],
    toDt: (r) => ({ x: dx + (r.x - ox) * k, y: dy + (r.y - oy) * k, w: r.w * k, h: r.h * k }),
    toOv: (r) => ({ x: ox + (r.x - dx) / k, y: oy + (r.y - dy) / k, w: r.w / k, h: r.h / k }),
  };
}

// The same picture, with its viewBox in the other drawing's coordinates.
function express(image: Image, space: Space, anchors: Anchors): Image {
  if (image.space === space) {
    return image;
  }

  if (image.align === null) {
    throw new Error("camera: switching drawings needs an aligned zone");
  }

  const a = alignment(anchorOf(anchors, image.align));

  return { ...image, space, vb: space === "dt" ? a.toDt(image.vb) : a.toOv(image.vb) };
}

const easeInOut = (p: number): number => (p < 0.5 ? 4 * p ** 3 : 1 - (2 - 2 * p) ** 3 / 2);

const smoothstep = (s: number): number => s * s * (3 - 2 * s);

// The image of a move at time now. The width moves on a log scale, so
// zooming in and out feel the same speed. The pivot (a zone's centre) glides
// on screen from where it stood to where it ends, so the zone stays in view
// all along. The drawings cross-fade during the middle third.
export function shown(cam: Camera, now: number): Image {
  if (cam.kind === "idle") {
    return cam.image;
  }

  const p = clamp01((now - cam.t0) / cam.dur);
  const e = easeInOut(p);
  const f = smoothstep(clamp01(3 * p - 1));
  const { from: a, to: b } = cam;
  const [px, py] = cam.pivot;
  const w = Math.exp(lerp(Math.log(a.vb.w), Math.log(b.vb.w), e));
  const h = Math.exp(lerp(Math.log(a.vb.h), Math.log(b.vb.h), e));
  const ux = lerp((px - a.vb.x) / a.vb.w, (px - b.vb.x) / b.vb.w, e);
  const uy = lerp((py - a.vb.y) / a.vb.h, (py - b.vb.y) / b.vb.h, e);

  return {
    space: b.space,
    align: b.align,
    vb: { x: px - ux * w, y: py - uy * h, w, h },
    op: { ov: lerp(a.op.ov, b.op.ov, f), dt: lerp(a.op.dt, b.op.dt, f) },
  };
}

// A drawing still fading keeps its alignment, or it would jump.
function go(cam: Camera, ev: Extract<CameraEvent, { type: "go" }>, anchors: Anchors): Camera {
  const cur = shown(cam, ev.now);
  const other = cur.space === "ov" ? cur.op.dt : cur.op.ov;
  const switches = ev.to.space !== cur.space;
  const keep = !switches || (other > 0 && cur.align !== null);
  const align = keep ? cur.align : ev.link;
  const to: Image = { ...ev.to, align };

  if (ev.dur <= 0) {
    return { kind: "idle", image: to };
  }

  const pivot =
    switches && ev.link !== null ? center(anchorOf(anchors, ev.link)[to.space]) : center(to.vb);

  return {
    kind: "moving",
    from: express({ ...cur, align }, to.space, anchors),
    to,
    pivot,
    t0: ev.now,
    dur: ev.dur,
  };
}

export function camera(cam: Camera, ev: CameraEvent, anchors: Anchors): Camera {
  switch (ev.type) {
    case "jump": {
      return { kind: "idle", image: ev.image };
    }

    case "tick": {
      return cam.kind === "moving" && ev.now >= cam.t0 + cam.dur
        ? { kind: "idle", image: cam.to }
        : cam;
    }

    case "go": {
      return go(cam, ev, anchors);
    }

    default: {
      const unknown: never = ev;

      return unknown;
    }
  }
}
