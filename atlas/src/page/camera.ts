// The camera, pure (no DOM, no clock): engine.ts feeds it events and paints the Image it returns;
// camera.spec.ts runs it.
//
// Every view is drawn in its own coordinates, on its own layer. An Image names the view whose
// coordinates the viewBox is in, and at most one other view, drawn through the similarity between
// the two (the boxes along their path, Between) so that its frame wraps the first's; the others are
// hidden. A move started while another runs starts from the image shown at that moment: the screen
// never jumps.
import type { Point, Rect, Similarity } from "./geometry.ts";
import { IDENTITY, applyRect, center, compose, fitting, invert } from "./geometry.ts";

/** A view's coordinates: the container's id, null for the root's. */
export type Key = string | null;

/** The similarity from one view's coordinates into another's. */
export type Between = (from: Key, to: Key) => Similarity;

/** A container's box in its parent's view, and the frame of its own view's boxes. */
export type Anchor = { readonly box: Rect; readonly frame: Rect };

export type Anchors = {
  /** The containers from a child of the root down to the key; none for the root. */
  readonly chainOf: (key: Key) => readonly string[];
  readonly anchorOf: (container: string) => Anchor;
};

/**
 * The similarity between any two views: each view's frame lands in its box in the parent's view,
 * level by level up to the root, and the other way down.
 */
export function betweenOf({ chainOf, anchorOf }: Anchors): Between {
  const toRoot = (key: Key): Similarity =>
    chainOf(key)
      .toReversed()
      .reduce((s, id) => {
        const { box, frame } = anchorOf(id);

        return compose(s, fitting(frame, box));
      }, IDENTITY);

  return (from, to) => (from === to ? IDENTITY : compose(toRoot(from), invert(toRoot(to))));
}

export type Fading = { readonly space: Key; readonly op: number };

/**
 * What the screen shows: the viewBox in `space`'s coordinates, that layer at opacity `op`, and at
 * most one `other` layer, aligned onto `space` and at its own opacity.
 */
export type Image = {
  readonly space: Key;
  readonly vb: Rect;
  readonly op: number;
  readonly other: Fading | null;
};

export type Target = { readonly space: Key; readonly vb: Rect };

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

export type CameraEvent =
  | { readonly type: "jump"; readonly image: Image }
  | { readonly type: "tick"; readonly now: number }
  | { readonly type: "go"; readonly to: Target; readonly now: number; readonly dur: number };

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const area = (r: Rect): number => r.w * r.h;

/**
 * The same picture, with its viewBox in another view's coordinates. The other layer of the image
 * takes the first's place when it is that view; a third view starts from the layer that shows
 * most, alone.
 */
export function express(image: Image, space: Key, between: Between): Image {
  if (image.space === space) {
    return image;
  }

  if (image.other?.space === space) {
    return {
      space,
      vb: applyRect(between(image.space, space), image.vb),
      op: image.other.op,
      other: { space: image.space, op: image.op },
    };
  }

  const shownMost: Fading =
    image.other !== null && image.other.op > image.op
      ? image.other
      : { space: image.space, op: image.op };

  const vb =
    shownMost.space === image.space
      ? image.vb
      : applyRect(between(image.space, shownMost.space), image.vb);

  return {
    space,
    vb: applyRect(between(shownMost.space, space), vb),
    op: 0,
    other: { space: shownMost.space, op: 1 },
  };
}

const easeInOut = (p: number): number => (p < 0.5 ? 4 * p ** 3 : 1 - (2 - 2 * p) ** 3 / 2);

const smoothstep = (s: number): number => s * s * (3 - 2 * s);

/**
 * The image of a move at time now. The width moves on a log scale, so zooming in and out feel the
 * same speed. The pivot glides on screen from where it stood to where it ends, so the view entered
 * or left stays in sight all along. The layers cross-fade during the middle third.
 */
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
    vb: { x: px - ux * w, y: py - uy * h, w, h },
    op: lerp(a.op, b.op, f),
    other:
      a.other === null || b.other === null
        ? null
        : { space: a.other.space, op: lerp(a.other.op, b.other.op, f) },
  };
}

// The pivot is the centre of the smaller frame: the view entered, or the one left.
function go(cam: Camera, ev: Extract<CameraEvent, { type: "go" }>, between: Between): Camera {
  const from = express(shown(cam, ev.now), ev.to.space, between);

  const to: Image = {
    space: ev.to.space,
    vb: ev.to.vb,
    op: 1,
    other: from.other === null ? null : { space: from.other.space, op: 0 },
  };

  if (ev.dur <= 0) {
    return { kind: "idle", image: to };
  }

  return {
    kind: "moving",
    from,
    to,
    pivot: center(area(from.vb) < area(to.vb) ? from.vb : to.vb),
    t0: ev.now,
    dur: ev.dur,
  };
}

export function camera(cam: Camera, ev: CameraEvent, between: Between): Camera {
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
      return go(cam, ev, between);
    }

    default: {
      const unknown: never = ev;

      return unknown;
    }
  }
}
