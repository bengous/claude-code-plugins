import { describe, expect, test } from "bun:test";

import ELK from "elkjs/lib/elk-api.js";

import type { Side } from "./atlas.ts";
import LARGE from "./fixtures/large/map.ts";
import type { Size } from "./geometry.ts";
import type { Layouter, LayoutEdge, Leaf } from "./layout.ts";
import { edgeOf, elkLayered } from "./layout.ts";
import { OUT, copyOf } from "./placement.ts";
import { treeOf } from "./tree.ts";
import type { View } from "./view.ts";
import { viewOf } from "./view.ts";

/** What ELK's PromisedWorker and its worker exchange: a request and its answer share an id. */
type Packet = { readonly id: number };

type Port = {
  onmessage: ((m: MessageEvent<Packet>) => void) | null;
  postMessage: (m: Packet) => void;
};

// Under Bun `self` exists, so elk-worker.js takes its web worker branch: it reads a request from
// self.onmessage and answers it through postMessage. This layouter is the other end of that
// worker: the port it hands ELK forwards a request to self.onmessage, and what the worker posts
// back comes to the port's onmessage.
async function bunLayouter(): Promise<Layouter> {
  let port: Port | null = null;

  Reflect.set(globalThis, "postMessage", (answer: Packet) => {
    port?.onmessage?.(new MessageEvent("message", { data: answer }));
  });

  await import("elkjs/lib/elk-worker.js");

  return new ELK({
    workerFactory: () => {
      const made: Port = {
        onmessage: null,
        postMessage: (m: Packet) => {
          port = made;
          setTimeout(() => self.onmessage?.call(self, new MessageEvent("message", { data: m })), 0);
        },
      };

      // SAFETY: ELK's PromisedWorker calls postMessage and sets onmessage on its worker, nothing else.
      return made as Worker;
    },
  });
}

const CARD: Size = { w: 70, h: 40 };

const GHOST: Size = { w: 60, h: 24 };

const labelSize = (label: string): Size => ({ w: label.length * 7, h: 14 });

const lanesOf = (side: Side | null): Array<Exclude<Side, "both"> | null> =>
  side === "both" ? ["in", "out"] : [side];

/** The leaves of a layered view as draw.ts makes them: an item in both columns twice. */
function leavesOf(view: View): Leaf[] {
  const blocks = [
    ...view.boxes.map((b) => ({ id: b.id, side: b.column, ...CARD })),
    ...view.ghosts.map((g) => ({ id: g.id, side: g.side, ...GHOST })),
  ];

  return blocks.flatMap((b) =>
    lanesOf(b.side).map((lane): Leaf => ({
      id: b.side === "both" && lane === "out" ? b.id + OUT : b.id,
      w: b.w,
      h: b.h,
      edge: edgeOf(lane),
    })),
  );
}

function edgesOf(view: View, leaves: readonly Leaf[]): LayoutEdge[] {
  const twice = new Set(
    leaves.flatMap((l) => (l.id.endsWith(OUT) ? [l.id.slice(0, -OUT.length)] : [])),
  );

  return view.arrows.map((a) => ({
    from: copyOf(a.from, twice.has(a.from), false),
    to: copyOf(a.to, twice.has(a.to), true),
    label: a.label,
  }));
}

type Laid = Awaited<ReturnType<typeof elkLayered>>;

/** The held leaves a free one stands wholly left or right of, against the side they are held to. */
function astray(leaves: readonly Leaf[], laid: Laid): string[] {
  const rect = (id: string) => laid.boxes.get(id) ?? fail(`no box ${id}`);
  const free = leaves.flatMap((l) => (l.edge === null ? [rect(l.id)] : []));
  const minRight = Math.min(...free.map((r) => r.x + r.w));
  const maxLeft = Math.max(...free.map((r) => r.x));

  return leaves.flatMap((l) => {
    const r = rect(l.id);

    return (l.edge === "first" && r.x >= minRight) || (l.edge === "last" && r.x + r.w <= maxLeft)
      ? [l.id]
      : [];
  });
}

function fail(message: string): never {
  throw new Error(message);
}

describe("elkLayered", () => {
  test("a held ghost stands at the edge even when its arrows join no card of the others", async () => {
    const elk = await bunLayouter();

    const leaves: Leaf[] = [
      { id: "a", ...CARD, edge: null },
      { id: "b", ...CARD, edge: null },
      { id: "c", ...CARD, edge: null },
      { id: "d", ...CARD, edge: null },
      { id: "g", ...GHOST, edge: "last" },
      { id: "h", ...GHOST, edge: "first" },
    ];

    const laid = await elkLayered(
      leaves,
      [
        { from: "a", to: "g", label: "" },
        { from: "h", to: "d", label: "" },
        { from: "b", to: "c", label: "" },
        { from: "c", to: "d", label: "" },
      ],
      labelSize,
      elk,
    );

    expect(astray(leaves, laid)).toEqual([]);
  });

  test("in every layered view of a wide map, no card stands wholly left of an in ghost or right of an out ghost", async () => {
    const elk = await bunLayouter();
    const tree = treeOf(LARGE);
    const checked: string[] = [];

    for (const [id, node] of tree.nodes) {
      const view = node.children === undefined ? null : viewOf(tree, id);

      if (
        view === null ||
        view.boxes.some((b) => b.kind === "container") ||
        view.ghosts.length === 0
      ) {
        continue;
      }

      const leaves = leavesOf(view);
      const laid = await elkLayered(leaves, edgesOf(view, leaves), labelSize, elk);

      expect(astray(leaves, laid), `view ${id}`).toEqual([]);
      checked.push(id);
    }

    expect(checked.length).toBeGreaterThan(40);
  });
});
