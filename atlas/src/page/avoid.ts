/* oxlint-disable anti-slop/no-shape-in-symbol-names -- libavoid's own API names its obstacle class ShapeRef, a name that is the library's, not ours. */
import { AvoidLib } from "libavoid-js";
import type { Avoid, ConnEndLike, ConnRef, ShapeRef } from "libavoid-js";

import type { Pins } from "../model/atlas.ts";
import type { Point, Rect } from "./geometry.ts";

// libavoid routes a packed view's arrows orthogonally, around every box, and
// spreads parallel segments apart (nudging). It is WebAssembly: AvoidLib.load
// fetches libavoid.wasm next to the page, which serve.ts answers with the
// dist/libavoid.wasm of the installed libavoid-js package.
// Traps:
//   - pins, several per side, follow the Config's `pins`: "shared" pins with
//     nudgeSharedPathsWithCommonEndPoint off let arrows into the same box end
//     at the same pin and run as one trunk; "exclusive" pins give each arrow
//     its own end, with that option on;
//   - router.delete() frees the WebAssembly memory of the whole routing.
const PIN_CLASS = 1;

const PIN_STEPS = [0.2, 0.35, 0.5, 0.65, 0.8];

let loaded: Avoid | null = null;

async function load(): Promise<Avoid> {
  if (loaded === null) {
    await AvoidLib.load("libavoid.wasm");
    loaded = AvoidLib.getInstance();
  }

  return loaded;
}

export type Link = { readonly from: string; readonly to: string };

function addPins(A: Avoid, shape: ShapeRef, mode: Pins): void {
  const { ConnDirUp, ConnDirDown, ConnDirLeft, ConnDirRight } = A.ConnDirFlag;

  for (const t of PIN_STEPS) {
    for (const [x, y, directions] of [
      [t, 0, ConnDirUp],
      [t, 1, ConnDirDown],
      [0, t, ConnDirLeft],
      [1, t, ConnDirRight],
    ] as const) {
      shape
        .addPin({ classId: PIN_CLASS, x, y, proportional: true, insideOffset: 0, directions })
        .setExclusive(mode === "exclusive");
    }
  }
}

function polyline(connector: ConnRef): Point[] {
  return connector.displayRoute().map((p): Point => [p.x, p.y]);
}

// One orthogonal route per link, between the boxes it names, around every
// box and every extra obstacle.
export async function routeLinks(
  boxes: ReadonlyMap<string, Rect>,
  extra: readonly Rect[],
  links: readonly Link[],
  pins: Pins,
): Promise<Point[][]> {
  const A = await load();
  const router = new A.Router(A.RouterFlag.OrthogonalRouting);

  try {
    router.setRoutingParameter(A.RoutingParameter.shapeBufferDistance, 14);
    router.setRoutingParameter(A.RoutingParameter.idealNudgingDistance, 12);
    router.setRoutingParameter(A.RoutingParameter.segmentPenalty, 60);
    router.setRoutingOption(A.RoutingOption.nudgeOrthogonalSegmentsConnectedToShapes, true);
    router.setRoutingOption(
      A.RoutingOption.nudgeSharedPathsWithCommonEndPoint,
      pins === "exclusive",
    );
    router.setRoutingOption(A.RoutingOption.performUnifyingNudgingPreprocessingStep, true);
    const shapes = new Map<string, ShapeRef>();

    for (const [id, r] of boxes) {
      const shape = router.addShape({ x: r.x, y: r.y, width: r.w, height: r.h });
      addPins(A, shape, pins);
      shapes.set(id, shape);
    }

    for (const r of extra) {
      router.addShape({ x: r.x, y: r.y, width: r.w, height: r.h });
    }

    const endOf = (id: string): ConnEndLike => {
      const shape = shapes.get(id);

      if (shape === undefined) {
        throw new Error(`libavoid: no box ${id}`);
      }

      return { shape, pin: PIN_CLASS };
    };

    const connectors = links.map((l) => router.addConnector(endOf(l.from), endOf(l.to)));
    router.processTransaction();

    return connectors.map((c) => polyline(c));
  } finally {
    router.delete();
  }
}
