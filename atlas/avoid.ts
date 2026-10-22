/* oxlint-disable anti-slop/no-shape-in-symbol-names, anti-slop/no-runtime-typeof -- libavoid's own API names its obstacle class ShapeRef and its pins ShapeConnectionPin, names that are the library's, not ours; and isAvoid IS the boundary parser of the module the WebAssembly loader hands back untyped. */
import { AvoidLib } from "libavoid-js";

import type { Pins } from "./atlas.ts";
import type { Point, Rect } from "./geometry.ts";

// libavoid routes a packed view's arrows orthogonally, around every box, and
// spreads parallel segments apart (nudging). It is WebAssembly: AvoidLib.load
// fetches libavoid.wasm next to the page, which serve.ts answers with the
// dist/libavoid.wasm of the installed libavoid-js package.
// Traps:
//   - the embind enums are objects: pass RouterFlag.OrthogonalRouting.value,
//     not the enum, or the constructor throws "Cannot convert undefined";
//   - ConnDirFlags is not exported: DIR below holds libavoid's values;
//   - pins, several per side, follow the Config's `pins`: "shared" pins with
//     nudgeSharedPathsWithCommonEndPoint off let arrows into the same box end
//     at the same pin and run as one trunk; "exclusive" pins give each arrow
//     its own end, with that option on;
//   - router.delete() frees the WebAssembly memory of the whole routing.
//
// The part of libavoid this plan calls. The package's own types leave the
// router flags untyped (an `any` index signature), so this subset is the
// contract.
type EnumValue = { readonly value: number };

type AvoidPoint = { readonly x: number; readonly y: number };

type Route = { size: () => number; at: (i: number) => AvoidPoint };

type Router = {
  setRoutingParameter: (parameter: EnumValue, value: number) => void;
  setRoutingOption: (option: EnumValue, value: boolean) => void;
  processTransaction: () => void;
  delete: () => void;
};

type Obstacle = { readonly kind?: "obstacle" };

type Pin = { setExclusive: (exclusive: boolean) => void };

type End = { readonly kind?: "end" };

type Connector = { displayRoute: () => Route };

type AvoidApi = {
  readonly Router: new (flags: number) => Router;
  readonly RouterFlag: { readonly OrthogonalRouting: EnumValue };
  readonly RoutingParameter: {
    readonly shapeBufferDistance: EnumValue;
    readonly idealNudgingDistance: EnumValue;
    readonly segmentPenalty: EnumValue;
  };
  readonly RoutingOption: {
    readonly nudgeOrthogonalSegmentsConnectedToShapes: EnumValue;
    readonly nudgeSharedPathsWithCommonEndPoint: EnumValue;
    readonly performUnifyingNudgingPreprocessingStep: EnumValue;
  };
  readonly Point: new (x: number, y: number) => AvoidPoint;
  readonly Rectangle: new (topLeft: AvoidPoint, bottomRight: AvoidPoint) => AvoidPoint;
  readonly ShapeRef: new (router: Router, polygon: AvoidPoint) => Obstacle;
  readonly ShapeConnectionPin: new (
    obstacle: Obstacle,
    classId: number,
    x: number,
    y: number,
    proportional: boolean,
    insideOffset: number,
    directions: number,
  ) => Pin;
  readonly ConnEnd: new (obstacle: Obstacle, classId: number) => End;
  readonly ConnRef: new (router: Router, from: End, to: End) => Connector;
};

const DIR = { up: 1, down: 2, left: 4, right: 8 };

const PIN_CLASS = 1;

const PIN_STEPS = [0.2, 0.35, 0.5, 0.65, 0.8];

const MEMBERS = [
  "Router",
  "RouterFlag",
  "RoutingParameter",
  "RoutingOption",
  "Point",
  "Rectangle",
  "ShapeRef",
  "ShapeConnectionPin",
  "ConnEnd",
  "ConnRef",
] as const;

// The embind module carries every member AvoidApi lists once load() is done.
function isAvoid(lib: unknown): lib is AvoidApi {
  return typeof lib === "object" && lib !== null && MEMBERS.every((m) => m in lib);
}

let loaded: AvoidApi | null = null;

async function load(): Promise<AvoidApi> {
  if (loaded === null) {
    await AvoidLib.load("libavoid.wasm");
    const lib: unknown = AvoidLib.getInstance();

    if (!isAvoid(lib)) {
      throw new Error(`libavoid-js: the module lacks one of ${MEMBERS.join(", ")}`);
    }

    loaded = lib;
  }

  return loaded;
}

export type Link = { readonly from: string; readonly to: string };

function obstacle(A: AvoidApi, router: Router, r: Rect): Obstacle {
  return new A.ShapeRef(
    router,
    new A.Rectangle(new A.Point(r.x, r.y), new A.Point(r.x + r.w, r.y + r.h)),
  );
}

function addPins(A: AvoidApi, o: Obstacle, mode: Pins): void {
  for (const t of PIN_STEPS) {
    for (const [x, y, dir] of [
      [t, 0, DIR.up],
      [t, 1, DIR.down],
      [0, t, DIR.left],
      [1, t, DIR.right],
    ] as const) {
      new A.ShapeConnectionPin(o, PIN_CLASS, x, y, true, 0, dir).setExclusive(mode === "exclusive");
    }
  }
}

function polyline(route: Route): Point[] {
  return Array.from({ length: route.size() }, (_, i): Point => {
    const p = route.at(i);

    return [p.x, p.y];
  });
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
  const router = new A.Router(A.RouterFlag.OrthogonalRouting.value);

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
    const obstacles = new Map<string, Obstacle>();

    for (const [id, r] of boxes) {
      const o = obstacle(A, router, r);
      addPins(A, o, pins);
      obstacles.set(id, o);
    }

    for (const r of extra) {
      obstacle(A, router, r);
    }

    const endOf = (id: string): End => {
      const o = obstacles.get(id);

      if (o === undefined) {
        throw new Error(`libavoid: no box ${id}`);
      }

      return new A.ConnEnd(o, PIN_CLASS);
    };

    const connectors = links.map((l) => new A.ConnRef(router, endOf(l.from), endOf(l.to)));
    router.processTransaction();

    return connectors.map((c) => polyline(c.displayRoute()));
  } finally {
    router.delete();
  }
}
