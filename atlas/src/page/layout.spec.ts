import { describe, expect, test } from "bun:test";

import type { ElkNode } from "elkjs/lib/elk-api.js";
import ELK from "elkjs/lib/elk-api.js";

import LARGE from "../../fixtures/large/map.ts";
import type { Direction, Side } from "../model/atlas.ts";
import { treeOf } from "../model/tree.ts";
import type { View } from "../model/view.ts";
import { viewOf } from "../model/view.ts";
import type { Rect, Size } from "./geometry.ts";
import type { Edge, Layouter, LayoutEdge, Leaf } from "./layout.ts";
import { edgeOf, elkLayered } from "./layout.ts";
import { OUT, copyOf } from "./placement.ts";

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

const ASPECT = 1.2;

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
      rank: null,
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
  }));
}

type Laid = Awaited<ReturnType<typeof elkLayered>>;

/**
 * The held leaves out of place. The rows wrap, so a ghost held to the first layer starts the
 * first row and one held to the last ends the last row: no card in or above an in ghost's row
 * stands wholly left of it, no card in or below an out ghost's row stands wholly right of it.
 */
function astray(leaves: readonly Leaf[], laid: Laid): string[] {
  const rect = (id: string) => laid.boxes.get(id) ?? fail(`no box ${id}`);
  const free = leaves.flatMap((l) => (l.edge === null ? [rect(l.id)] : []));

  return leaves.flatMap((l) => {
    const r = rect(l.id);

    const wrong =
      l.edge === "first"
        ? free.some((c) => c.y < r.y + r.h && c.x + c.w <= r.x)
        : l.edge === "last"
          ? free.some((c) => c.y + c.h > r.y && c.x >= r.x + r.w)
          : false;

    return wrong ? [`${l.id} (${l.edge})`] : [];
  });
}

function fail(message: string): never {
  throw new Error(message);
}

describe("elkLayered", () => {
  test("a held ghost stands at the edge even when its arrows join no card of the others", async () => {
    const elk = await bunLayouter();

    const leaves: Leaf[] = [
      { id: "a", ...CARD, edge: null, rank: null },
      { id: "b", ...CARD, edge: null, rank: null },
      { id: "c", ...CARD, edge: null, rank: null },
      { id: "d", ...CARD, edge: null, rank: null },
      { id: "g", ...GHOST, edge: "last", rank: null },
      { id: "h", ...GHOST, edge: "first", rank: null },
    ];

    const laid = await elkLayered(
      leaves,
      [
        { from: "a", to: "g" },
        { from: "h", to: "d" },
        { from: "b", to: "c" },
        { from: "c", to: "d" },
      ],
      ASPECT,
      elk,
    );

    expect(astray(leaves, laid)).toEqual([]);
  });

  test("in every layered view of a wide map, an in ghost starts its row and an out ghost ends its row, whatever the rows above or below", async () => {
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
      const laid = await elkLayered(leaves, edgesOf(view, leaves), ASPECT, elk);

      expect(astray(leaves, laid), `view ${id}`).toEqual([]);
      checked.push(id);
    }

    expect(checked.length).toBeGreaterThan(40);
  });
});

function leaf(id: string, rank: number | null, edge: Edge = null): Leaf {
  return { id, ...(edge === null ? CARD : GHOST), edge, rank };
}

// Where a leaf belongs along the reading direction: a ghost held to the first layer before every
// leaf, then the ranks in order, then the unranked leaves, then a ghost held to the last layer.
const placeOf = (l: Leaf): number =>
  l.edge === "first"
    ? -Infinity
    : l.edge === "last"
      ? Infinity
      : (l.rank ?? Number.MAX_SAFE_INTEGER);

const ahead = (a: Rect, b: Rect, direction: Direction): boolean =>
  direction === "DOWN" ? a.y + a.h <= b.y : a.x + a.w <= b.x;

/** Each pair of leaves where the one that belongs first does not end before the other starts. */
function disordered(leaves: readonly Leaf[], laid: Laid, direction: Direction): string[] {
  const rect = (id: string) => laid.boxes.get(id) ?? fail(`no box ${id}`);

  return leaves.flatMap((a) =>
    leaves.flatMap((b) =>
      placeOf(a) < placeOf(b) && !ahead(rect(a.id), rect(b.id), direction)
        ? [`${a.id} before ${b.id}`]
        : [],
    ),
  );
}

const RANKED: Leaf[] = [
  leaf("a", 2),
  leaf("b", 0),
  leaf("c", 1),
  leaf("d", 1),
  leaf("e", null),
  leaf("g", null, "first"),
  leaf("h", null, "last"),
];

// Arrows against the ranks: a leaf's rank, not its arrows, sets its layer.
const AGAINST: LayoutEdge[] = [
  { from: "a", to: "b" },
  { from: "b", to: "c" },
  { from: "c", to: "d" },
  { from: "d", to: "a" },
  { from: "e", to: "b" },
  { from: "g", to: "c" },
  { from: "a", to: "h" },
];

/** A layouter that keeps every graph it is handed. */
type Recorder = { readonly layouter: Layouter; readonly graphs: ElkNode[] };

function recorder(elk: Layouter): Recorder {
  const graphs: ElkNode[] = [];

  return {
    graphs,
    layouter: {
      layout: (graph) => {
        graphs.push(graph);

        return elk.layout(graph);
      },
    },
  };
}

describe("elkLayered by rank", () => {
  test.each(["DOWN", "RIGHT"] as const)(
    "%s: each leaf's layer follows its rank whatever its arrows, an unranked leaf after them, a held ghost at its end",
    async (direction) => {
      const elk = await bunLayouter();
      const laid = await elkLayered(RANKED, AGAINST, ASPECT, elk, direction);

      expect(disordered(RANKED, laid, direction)).toEqual([]);
    },
  );

  test("a ranked view keeps its layers in one line: a chain its rows wrap unranked stays whole ranked", async () => {
    const elk = await bunLayouter();
    const chain = Array.from({ length: 8 }, (_, i) => leaf(`n${i}`, i));
    const edges = chain.slice(1).map((l, i): LayoutEdge => ({ from: `n${i}`, to: l.id }));
    const unranked = chain.map((l) => leaf(l.id, null));

    const wrapped = await elkLayered(unranked, edges, 0.5, elk, "RIGHT");
    expect(disordered(chain, wrapped, "RIGHT")).not.toEqual([]);

    const whole = await elkLayered(chain, edges, 0.5, elk, "RIGHT");
    expect(disordered(chain, whole, "RIGHT")).toEqual([]);
  });

  test("ELK's options: the direction, a partition per node in rank order between the held ghosts, no wrapping", async () => {
    const { layouter, graphs } = recorder(await bunLayouter());
    await elkLayered(RANKED, AGAINST, ASPECT, layouter, "DOWN");
    const [graph] = graphs;

    expect(graph?.layoutOptions).toMatchObject({
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.partitioning.activate": "true",
      "elk.layered.wrapping.strategy": "OFF",
    });

    expect(graph?.children?.map((c) => [c.id, c.layoutOptions])).toEqual([
      ["a", { "elk.partitioning.partition": "3" }],
      ["b", { "elk.partitioning.partition": "1" }],
      ["c", { "elk.partitioning.partition": "2" }],
      ["d", { "elk.partitioning.partition": "2" }],
      ["e", { "elk.partitioning.partition": "4" }],
      ["g", { "elk.layered.layering.layerConstraint": "FIRST", "elk.partitioning.partition": "0" }],
      ["h", { "elk.layered.layering.layerConstraint": "LAST", "elk.partitioning.partition": "5" }],
    ]);
  });

  test("ELK's options for a view without a rank: left to right by default, wrapped, unpartitioned", async () => {
    const { layouter, graphs } = recorder(await bunLayouter());
    const unranked = RANKED.map((l) => leaf(l.id, null, l.edge));
    await elkLayered(unranked, AGAINST, ASPECT, layouter);
    const [graph] = graphs;

    expect(graph?.layoutOptions).toMatchObject({
      "elk.direction": "RIGHT",
      "elk.layered.wrapping.strategy": "MULTI_EDGE",
    });

    expect(graph?.layoutOptions).not.toHaveProperty(["elk.partitioning.activate"]);

    expect(
      graph?.children?.flatMap((c) =>
        Object.keys(c.layoutOptions ?? {}).filter((k) => k.startsWith("elk.partitioning")),
      ),
    ).toEqual([]);
  });
});
