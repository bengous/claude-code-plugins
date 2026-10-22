import { describe, expect, test } from "bun:test";

import type { Link, Node } from "./atlas.ts";
import SAMPLE from "./fixtures/sample/map.ts";
import { DEEP, randomMap } from "./fixtures/trees.ts";
import type { Tree } from "./tree.ts";
import { chainOf, childrenOf, itemIn, liftIn, treeOf } from "./tree.ts";
import type { Arrow, View } from "./view.ts";
import { coupledIn, lights, viewOf } from "./view.ts";

const sample = treeOf(SAMPLE);

const deep = treeOf(DEEP);

const pair = (a: Arrow): string => `${a.from} → ${a.to}`;

const pairs = (view: View): string[] => view.arrows.map(pair);

const arrow = (view: View, from: string, to: string): Arrow => {
  const found = view.arrows.find((a) => a.from === from && a.to === to);

  if (found === undefined) {
    throw new Error(`no arrow ${from} → ${to} in ${pairs(view).join(", ")}`);
  }

  return found;
};

const ghosts = (view: View): string[] => view.ghosts.map((g) => `${g.id} ${g.side}`);

const card = (id: string, extra: Partial<Node> = {}): Node => ({
  id,
  label: id,
  sub: "",
  color: "c",
  ...extra,
});

const twoBoxes = (links: readonly Link[]): Tree =>
  treeOf({
    root: {
      title: "T",
      children: [
        card("A", { children: [card("a1"), card("a2")] }),
        card("B", { children: [card("b1"), card("b2")] }),
      ],
    },
    links,
  });

const rootArrows = (links: readonly Link[]): readonly Arrow[] =>
  viewOf(twoBoxes(links), null).arrows;

describe("the sample's views", () => {
  test("the root: a box per child, outside ones in their side's column, every link lifted", () => {
    expect(viewOf(sample, null)).toEqual({
      id: null,
      boxes: [
        {
          kind: "container",
          id: "clients",
          label: "Clients",
          sub: "outside the server",
          color: "clients",
          open: 0,
          column: "in",
          chips: [{ id: "browser", label: "Browser", color: "clients", off: false, open: 0 }],
        },
        {
          kind: "container",
          id: "server",
          label: "Server",
          sub: "one virtual machine",
          color: "server",
          open: 1,
          column: null,
          chips: [
            { id: "proxy", label: "Reverse proxy", color: "server", off: false, open: 0 },
            { id: "app", label: "Application", color: "app", off: false, open: 0 },
            { id: "data", label: "Storage", color: "data", off: false, open: 1 },
          ],
        },
        {
          kind: "leaf",
          id: "email",
          label: "Email service",
          sub: "transactional mail API",
          color: "external",
          open: 0,
          column: "out",
          off: false,
        },
      ],
      ghosts: [],
      arrows: [
        {
          from: "server",
          to: "email",
          label: "order mail",
          kind: "flow",
          two: false,
          tags: ["account", "order"],
          links: [1, 8],
          ends: ["app", "email", "orders"],
        },
        {
          from: "clients",
          to: "server",
          label: "HTTPS",
          kind: "flow",
          two: false,
          tags: [],
          links: [2],
          ends: ["browser", "proxy"],
        },
      ],
      legend: { flow: true, dash: false, deny: false, coupled: true, outside: true, open: true },
    });
  });

  test("the server: links between its children lift to them, the others bring ghosts", () => {
    const view = viewOf(sample, "server");

    expect(view.boxes.map((b) => `${b.kind} ${b.id}`)).toEqual([
      "leaf proxy",
      "container app",
      "container data",
    ]);

    expect(pairs(view)).toEqual(["app → data", "app → email", "clients → proxy", "proxy → app"]);

    expect(view.arrows.map((a) => a.label)).toEqual([
      "SQL",
      "order mail",
      "HTTPS",
      "HTTP app:3000",
    ]);

    expect(arrow(view, "app", "data").links).toEqual([0, 6, 7]);
    expect(arrow(view, "app", "data").ends).toEqual(["app", "data", "catalog", "db", "orders"]);

    expect(view.ghosts).toEqual([
      {
        id: "clients",
        label: "Clients",
        color: "clients",
        off: false,
        open: 0,
        outside: true,
        side: "in",
      },
      {
        id: "email",
        label: "Email service",
        color: "external",
        off: false,
        open: 0,
        outside: true,
        side: "out",
      },
    ]);
  });

  test("a dormant leaf stays dormant seen as a ghost", () => {
    const tree = treeOf({
      root: {
        title: "T",
        children: [
          card("A", {
            children: [card("A1", { children: [card("x")] }), card("a2", { kind: "off" })],
          }),
        ],
      },
      links: [{ from: "x", to: "a2", label: "l" }],
    });

    expect(viewOf(tree, "A1").ghosts.map((g) => [g.id, g.off])).toEqual([["a2", true]]);
    expect(viewOf(sample, "server").ghosts.map((g) => g.off)).toEqual([false, false]);
  });

  test("the application: every leaf a card, its neighbours lifted to the level they share", () => {
    const view = viewOf(sample, "app");

    expect(view.boxes.every((b) => b.kind === "leaf")).toBe(true);

    expect(pairs(view)).toEqual([
      "proxy → web",
      "web → catalog",
      "web → orders",
      "catalog → data",
      "orders → data",
      "orders → email",
    ]);

    expect(arrow(view, "orders", "email")).toMatchObject({
      label: "confirmation",
      tags: ["account", "order"],
    });

    expect(ghosts(view)).toEqual(["proxy in", "data out", "email out"]);
    expect(view.ghosts.find((g) => g.id === "data")?.open).toBe(1);
  });

  test("the storage: without a link set between the pair, the labels it gathers join", () => {
    const view = viewOf(sample, "data");

    expect(view.arrows).toEqual([
      {
        from: "app",
        to: "db",
        label: "SQL books · SQL orders",
        kind: "flow",
        two: false,
        tags: [],
        links: [6, 7],
        ends: ["catalog", "db", "orders"],
      },
      {
        from: "backup",
        to: "db",
        label: "pg_dump each night",
        kind: "dash",
        two: false,
        tags: [],
        links: [9],
        ends: ["backup", "db"],
      },
    ]);

    expect(ghosts(view)).toEqual(["app in"]);

    expect(view.legend).toEqual({
      flow: true,
      dash: true,
      deny: false,
      coupled: true,
      outside: false,
      open: true,
    });
  });

  test("an outside container: its neighbour is the server, lifted to the root's child", () => {
    const view = viewOf(sample, "clients");

    expect(pairs(view)).toEqual(["browser → server"]);
    expect(ghosts(view)).toEqual(["server out"]);
    expect(view.legend.outside).toBe(false);
    expect(view.legend.coupled).toBe(false);
  });

  test("a leaf has no view", () => {
    expect(() => viewOf(sample, "db")).toThrow("node db is a leaf, not a container");
  });
});

describe("the deep map's views", () => {
  test("the root: a link set between the pair with two merges both directions under its label", () => {
    const view = viewOf(deep, null);

    expect(pairs(view)).toEqual(["A → B", "A → X", "X → A", "Y → A"]);

    expect(arrow(view, "A", "B")).toEqual({
      from: "A",
      to: "B",
      label: "sync",
      kind: "flow",
      two: true,
      tags: ["t1"],
      links: [4, 5, 6],
      ends: ["a1", "b1", "b2", "a5", "A", "B"],
    });
  });

  test("the root: without a name, the first two labels join, and mixed kinds draw a plain flow", () => {
    expect(arrow(viewOf(deep, null), "A", "X")).toMatchObject({
      label: "p1 · p2",
      kind: "flow",
      links: [10, 11, 12],
    });
  });

  test("the root: an outside leaf on both sides keeps its column; no ghost at the root", () => {
    const view = viewOf(deep, null);

    expect(view.boxes.map((b) => [b.id, b.column])).toEqual([
      ["A", null],
      ["B", null],
      ["X", "both"],
      ["Y", "in"],
    ]);

    expect(view.ghosts).toEqual([]);
  });

  test("one level down, the far side of the root's merged pair splits into its two directions", () => {
    const view = viewOf(deep, "A");

    expect(pairs(view)).toEqual([
      "A1 → B",
      "B → A1",
      "A1 → A2",
      "A1 → X",
      "A2 → X",
      "X → A1",
      "Y → A1",
    ]);

    expect(arrow(view, "B", "A1")).toMatchObject({ kind: "deny", two: false, label: "far back" });
    expect(arrow(view, "A1", "A2")).toMatchObject({ label: "to A2", links: [7, 8, 9, 18] });
    expect(ghosts(view)).toEqual(["B both", "X both", "Y in"]);
  });

  test("a link with a leaf end names the arrow toward a ghost", () => {
    const view = viewOf(deep, "A1");

    expect(arrow(view, "A12", "A2")).toMatchObject({
      label: "feeds a6",
      kind: "flow",
      links: [8, 18],
      ends: ["a4", "a6", "A12"],
    });

    expect(arrow(view, "A11", "A2").label).toBe("q");
  });

  test("a pair joined both ways without a two stays two arrows", () => {
    const view = viewOf(deep, "A1");

    expect(arrow(view, "A11", "A12")).toMatchObject({ label: "cousin", two: false });
    expect(arrow(view, "A12", "A11")).toMatchObject({ label: "back", two: false });
    expect(ghosts(view)).toEqual(["A2 out", "B both", "X both", "Y in"]);
  });

  test("a single dashed link keeps its kind once lifted", () => {
    expect(arrow(viewOf(deep, "A11"), "a3", "X").kind).toBe("dash");
  });

  test("at depth 4, ghosts stand for the nearest branch on each path out", () => {
    const view = viewOf(deep, "A111");

    expect(pairs(view)).toEqual([
      "a1 → a2",
      "a1 → a3",
      "a1 → A12",
      "A12 → a2",
      "a1 → B",
      "a1 → X",
      "X → a2",
    ]);

    expect(ghosts(view)).toEqual(["a3 out", "A12 both", "B out", "X both"]);
    expect(view.legend).toMatchObject({ outside: true, open: true, coupled: true });
  });

  test("from the far branch, the whole near branch is one ghost", () => {
    const view = viewOf(deep, "B111");

    expect(pairs(view)).toEqual(["A → b1", "b2 → A", "b3 → b1", "b1 → b2"]);
    expect(ghosts(view)).toEqual(["A both", "b3 in"]);
  });

  test("two leaves joined both ways merge under the link with two, both labels kept", () => {
    expect(arrow(viewOf(deep, "B111"), "b1", "b2")).toMatchObject({
      label: "reply · pair",
      two: true,
      links: [16, 17],
    });
  });

  test("a view uses the legend lines of its own arrows and marks", () => {
    expect(viewOf(deep, "B").legend).toEqual({
      flow: true,
      dash: true,
      deny: true,
      coupled: true,
      outside: false,
      open: true,
    });

    expect(viewOf(deep, null).legend).toMatchObject({ dash: false, deny: false });
  });

  test("open points count down the whole subtree", () => {
    expect(viewOf(deep, null).boxes.map((b) => [b.id, b.open])).toEqual([
      ["A", 2],
      ["B", 2],
      ["X", 0],
      ["Y", 0],
    ]);

    expect(viewOf(deep, "A1").boxes.map((b) => [b.id, b.open])).toEqual([
      ["A11", 2],
      ["A12", 0],
    ]);
  });
});

describe("a pair's arrows", () => {
  test("a pair merges into one two-headed arrow as soon as one of its links has two", () => {
    const arrows = rootArrows([
      { from: "a1", to: "b1", label: "y", two: true },
      { from: "b2", to: "a2", label: "x" },
    ]);

    expect(arrows.map((a) => [pair(a), a.two, a.links])).toEqual([["A → B", true, [0, 1]]]);
  });

  test("the merged arrow takes the direction of the link set directly between the pair", () => {
    const arrows = rootArrows([
      { from: "b2", to: "a2", label: "x" },
      { from: "a1", to: "b1", label: "y", two: true },
      { from: "B", to: "A", label: "named" },
    ]);

    expect(arrows.map((a) => [pair(a), a.two, a.label])).toEqual([["B → A", true, "named"]]);
  });

  test("between two direct links, the one with two sets the direction", () => {
    const arrows = rootArrows([
      { from: "B", to: "A", label: "named" },
      { from: "A", to: "B", label: "back", two: true },
      { from: "a1", to: "b1", label: "y" },
    ]);

    expect(arrows.map((a) => [pair(a), a.links])).toEqual([["A → B", [0, 1, 2]]]);
  });

  test("without a direct link, the first link with two sets the direction, not the first link", () => {
    const arrows = rootArrows([
      { from: "b2", to: "a2", label: "x" },
      { from: "a1", to: "b1", label: "y", two: true },
    ]);

    expect(arrows.map((a) => pair(a))).toEqual(["A → B"]);
  });

  test("a pair joined both ways without two keeps two one-headed arrows", () => {
    const arrows = rootArrows([
      { from: "a1", to: "b1", label: "y" },
      { from: "b2", to: "a2", label: "x" },
    ]);

    expect(arrows.map((a) => [pair(a), a.two])).toEqual([
      ["A → B", false],
      ["B → A", false],
    ]);
  });
});

describe("coupledIn", () => {
  test("a leaf's couplings lift to the ghosts that stand for them", () => {
    const view = viewOf(sample, "app");

    expect(coupledIn(sample, view, "orders")).toEqual(["data", "email"]);
    expect(coupledIn(sample, view, "catalog")).toEqual(["data"]);
  });

  test("couplings are symmetric: one declared on the other side outlines too", () => {
    expect(coupledIn(sample, viewOf(sample, "app"), "web")).toEqual(["proxy"]);
    expect(coupledIn(sample, viewOf(sample, "data"), "db")).toEqual(["app", "backup"]);
  });

  test("a selected ghost outlines the boxes its couplings lift to", () => {
    expect(coupledIn(sample, viewOf(sample, "app"), "email")).toEqual(["orders"]);
    expect(coupledIn(sample, viewOf(sample, "app"), "proxy")).toEqual(["web"]);
  });

  test("at the root, a coupling lifts to the child that holds it", () => {
    expect(coupledIn(sample, viewOf(sample, null), "email")).toEqual(["server"]);
    expect(coupledIn(deep, viewOf(deep, null), "X")).toEqual(["A"]);
  });

  test("deep down, couplings lift to ghosts several levels up", () => {
    expect(coupledIn(deep, viewOf(deep, "A111"), "a1")).toEqual(["B", "A12"]);
    expect(coupledIn(deep, viewOf(deep, "B111"), "b2")).toEqual(["A"]);
  });

  test("a coupled node nothing in the view stands for outlines nothing", () => {
    expect(deep.couplings.get("y1")).toEqual(["b3"]);
    expect(coupledIn(deep, viewOf(deep, "Y"), "y1")).toEqual([]);
  });

  test("a selected container or ghost outlines what the nodes it holds are coupled with", () => {
    expect(coupledIn(sample, viewOf(sample, "app"), "data")).toEqual(["catalog", "orders"]);
    expect(coupledIn(sample, viewOf(sample, "server"), "data")).toEqual(["app"]);
    expect(coupledIn(deep, viewOf(deep, "A111"), "B")).toEqual(["a1"]);
  });

  test("once lifted, the outline is symmetric: either side of a pair outlines the other", () => {
    expect(coupledIn(sample, viewOf(sample, null), "email")).toEqual(["server"]);
    expect(coupledIn(sample, viewOf(sample, null), "server")).toEqual(["email"]);
    expect(coupledIn(sample, viewOf(sample, "app"), "orders")).toContain("data");
    expect(coupledIn(sample, viewOf(sample, "app"), "data")).toContain("orders");
  });

  test("a coupling between two nodes a box holds outlines nothing, never the box itself", () => {
    expect(sample.couplings.get("proxy")).toEqual(["web"]);
    expect(coupledIn(sample, viewOf(sample, null), "server")).toEqual(["email"]);
  });

  test("a node with no coupling in its subtree outlines nothing", () => {
    expect(coupledIn(sample, viewOf(sample, null), "clients")).toEqual([]);
  });
});

describe("lights", () => {
  test("an arrow lights for its boxes, its ghosts, and every node down to its links' ends", () => {
    const merged = arrow(viewOf(deep, null), "A", "B");

    for (const id of ["A", "B", "A1", "A11", "A111", "a1", "a5", "A12", "B1", "b1", "b2"]) {
      expect(lights(deep, merged, id)).toBe(true);
    }

    for (const id of ["A2", "a6", "b3", "X", "a3"]) {
      expect(lights(deep, merged, id)).toBe(false);
    }
  });

  test("a chip lights the arrows its own links stand in", () => {
    const toEmail = arrow(viewOf(sample, null), "server", "email");

    expect(lights(sample, toEmail, "app")).toBe(true);
    expect(lights(sample, toEmail, "orders")).toBe(true);
    expect(lights(sample, toEmail, "data")).toBe(false);
  });
});

const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89];

const containersOf = (tree: Tree): Array<string | null> => [
  null,
  ...[...tree.nodes.values()].flatMap((n) => (n.children === undefined ? [] : [n.id])),
];

function expectWellFormed(tree: Tree, container: string | null): void {
  const view = viewOf(tree, container);
  const boxes = view.boxes.map((b) => b.id);
  const ghostIds = view.ghosts.map((g) => g.id);
  const shown = new Set([...boxes, ...ghostIds]);

  expect(boxes).toEqual(childrenOf(tree, container).map((n) => n.id));

  for (const [i, link] of tree.map.links.entries()) {
    const from = liftIn(tree, container, link.from);
    const to = liftIn(tree, container, link.to);
    const carriers = view.arrows.filter((a) => a.links.includes(i));

    if (from === to) {
      expect(carriers).toEqual([]);
      continue;
    }

    const [a, b] = [itemIn(tree, container, link.from), itemIn(tree, container, link.to)];

    expect(
      carriers.map((c) => (c.from === a && c.to === b) || (c.from === b && c.to === a && c.two)),
    ).toEqual([true]);
  }

  const seen = new Set<string>();
  const drawn = new Set(view.arrows.map(pair));

  for (const a of view.arrows) {
    expect(a.from).not.toBe(a.to);
    expect(shown.has(a.from) && shown.has(a.to)).toBe(true);
    expect(boxes.includes(a.from) || boxes.includes(a.to)).toBe(true);
    expect(seen.has(pair(a))).toBe(false);
    seen.add(pair(a));
    expect(a.two).toBe(a.links.some((i) => tree.map.links[i]?.two === true));

    if (a.two) {
      expect(drawn.has(`${a.to} → ${a.from}`)).toBe(false);
    }

    for (const id of shown) {
      expect(lights(tree, a, id)).toBe(id === a.from || id === a.to);
    }
  }

  for (const g of view.ghosts) {
    const from = view.arrows.some((a) => a.from === g.id);
    const to = view.arrows.some((a) => a.to === g.id);

    expect(g.side).toBe(from ? (to ? "both" : "in") : "out");
    expect(from || to).toBe(true);
  }

  for (const b of view.boxes) {
    const own = [...tree.nodes.values()].flatMap((n) =>
      chainOf(tree, n.id).includes(b.id) ? (n.open ?? []) : [],
    );

    expect(b.open).toBe(own.length);
  }

  const outlines = new Map([...shown].map((id) => [id, coupledIn(tree, view, id)]));

  for (const [id, outlined] of outlines) {
    expect(outlined.every((o) => shown.has(o) && o !== id)).toBe(true);

    for (const other of outlined) {
      expect(outlines.get(other)).toContain(id);
    }
  }
}

describe("every view of a map", () => {
  test.each([
    ["the sample", sample],
    ["the deep map", deep],
    ...SEEDS.map((seed): [string, Tree] => [`random map ${seed}`, treeOf(randomMap(seed))]),
  ])(
    "%s: each link is one arrow, or inside one child, wherever it shows; boxes, ghosts and counts agree",
    (_, tree) => {
      for (const container of containersOf(tree)) {
        expectWellFormed(tree, container);
      }
    },
  );

  test("the random maps reach five levels, bring ghosts and merge pairs", () => {
    const trees = SEEDS.map((seed) => treeOf(randomMap(seed)));
    const depths = trees.flatMap((t) => [...t.chains.values()].map((c) => c.length));

    const views = trees.flatMap((t) => containersOf(t).map((c): [Tree, View] => [t, viewOf(t, c)]));

    const merged = views.flatMap(([t, view]) =>
      view.arrows.filter((a) =>
        a.links.some((i) => {
          const link = t.map.links[i];

          return link !== undefined && itemIn(t, view.id, link.from) === a.to;
        }),
      ),
    );

    expect(Math.max(...depths)).toBe(5);
    expect(views.some(([, view]) => view.ghosts.some((g) => g.side === "both"))).toBe(true);
    expect(merged.length).toBeGreaterThan(0);
  });
});
