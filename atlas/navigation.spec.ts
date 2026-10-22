import { describe, expect, test } from "bun:test";

import type { Node } from "./atlas.ts";
import SAMPLE from "./fixtures/sample/map.ts";
import { DEEP, randomMap } from "./fixtures/trees.ts";
import type { Place, PlaceEvent } from "./navigation.ts";
import { HOME, crumbsOf, hashOf, navigate, openOf, placeOfHash } from "./navigation.ts";
import type { Tree } from "./tree.ts";
import { chainOf, treeOf } from "./tree.ts";
import { viewOf } from "./view.ts";

const sample = treeOf(SAMPLE);

const deep = treeOf(DEEP);

const run = (tree: Tree, place: Place, events: readonly PlaceEvent[]): Place =>
  events.reduce((at, event) => navigate(tree, at, event), place);

const at = (path: readonly string[], selected: string | null = null): Place => ({ path, selected });

const card = (id: string): Node => ({ id, label: id, sub: "", color: "c" });

describe("enter", () => {
  test("a container child opens its view, one level at a time, clearing the selection", () => {
    const app = run(sample, HOME, [
      { type: "enter", id: "server" },
      { type: "select", id: "proxy" },
      { type: "enter", id: "app" },
    ]);

    expect(app).toEqual(at(["server", "app"]));
  });

  test("a leaf, a container deeper down, or a ghost leaves the place as it is", () => {
    const server = at(["server"]);

    for (const id of ["proxy", "web", "clients", "nowhere"]) {
      expect(navigate(sample, server, { type: "enter", id })).toBe(server);
    }

    expect(navigate(sample, HOME, { type: "enter", id: "app" })).toBe(HOME);
  });
});

describe("select", () => {
  test("a box of the open view is selected where it stands", () => {
    expect(navigate(sample, at(["server", "app"]), { type: "select", id: "orders" })).toEqual(
      at(["server", "app"], "orders"),
    );

    expect(navigate(sample, at(["server"]), { type: "select", id: "data" })).toEqual(
      at(["server"], "data"),
    );
  });

  test("a ghost is selected in place: the reader keeps the view the link was read from", () => {
    expect(navigate(sample, at(["server", "app"]), { type: "select", id: "email" })).toEqual(
      at(["server", "app"], "email"),
    );

    expect(navigate(deep, at(["A", "A1", "A11", "A111"]), { type: "select", id: "B" })).toEqual(
      at(["A", "A1", "A11", "A111"], "B"),
    );
  });

  test("a chip, a node the view does not show, or an unknown id leaves the place as it is", () => {
    const server = at(["server"], "proxy");

    for (const id of ["web", "db", "browser", "nowhere"]) {
      expect(navigate(sample, server, { type: "select", id })).toBe(server);
    }
  });
});

describe("up, home and escape", () => {
  test("up opens the parent's view and clears the selection; the root stays put", () => {
    expect(navigate(deep, at(["A", "A1", "A11"], "a3"), { type: "up" })).toEqual(at(["A", "A1"]));

    const root = at([], "X");

    expect(navigate(deep, root, { type: "up" })).toBe(root);
  });

  test("home opens the root's view from anywhere", () => {
    expect(navigate(deep, at(["B", "B1", "B11", "B111"], "b2"), { type: "home" })).toBe(HOME);
  });

  test("escape deselects first, then climbs one level per press, then rests at the root", () => {
    const steps = [at(["A", "A1", "A11", "A111"], "a1")];

    for (let i = 0; i < 6; i += 1) {
      const last = steps.at(-1) ?? HOME;
      steps.push(navigate(deep, last, { type: "escape" }));
    }

    expect(steps).toEqual([
      at(["A", "A1", "A11", "A111"], "a1"),
      at(["A", "A1", "A11", "A111"]),
      at(["A", "A1", "A11"]),
      at(["A", "A1"]),
      at(["A"]),
      HOME,
      HOME,
    ]);
  });

  test("escape at the root deselects", () => {
    expect(navigate(sample, at([], "email"), { type: "escape" })).toEqual(HOME);
  });
});

describe("jump", () => {
  test("a container opens its own view", () => {
    expect(navigate(sample, at(["server", "app"], "web"), { type: "jump", id: "data" })).toEqual(
      at(["server", "data"]),
    );

    expect(navigate(deep, HOME, { type: "jump", id: "B111" })).toEqual(
      at(["B", "B1", "B11", "B111"]),
    );

    expect(navigate(sample, HOME, { type: "jump", id: "clients" })).toEqual(at(["clients"]));
  });

  test("a leaf opens its parent's view with the leaf selected, at any depth", () => {
    expect(navigate(deep, HOME, { type: "jump", id: "a1" })).toEqual(
      at(["A", "A1", "A11", "A111"], "a1"),
    );

    expect(navigate(sample, at(["server"]), { type: "jump", id: "browser" })).toEqual(
      at(["clients"], "browser"),
    );
  });

  test("a leaf child of the root selects it on the root's view", () => {
    expect(navigate(sample, at(["server", "app"]), { type: "jump", id: "email" })).toEqual(
      at([], "email"),
    );
  });

  test("an unknown id, or none, opens the root's view", () => {
    expect(navigate(deep, at(["A"], "A1"), { type: "jump", id: "nowhere" })).toBe(HOME);
    expect(navigate(deep, at(["A"], "A1"), { type: "jump", id: "" })).toBe(HOME);
  });
});

describe("crumbsOf", () => {
  test("the root, the path, then the selected box marked selected", () => {
    expect(crumbsOf(sample, at(["server", "app"], "orders"))).toEqual([
      { kind: "root" },
      { kind: "node", id: "server", label: "Server", selected: false },
      { kind: "node", id: "app", label: "Application", selected: false },
      { kind: "node", id: "orders", label: "Orders", selected: true },
    ]);
  });

  test("a selected ghost ends the breadcrumb, marked selected", () => {
    expect(crumbsOf(sample, at(["server", "app"], "email")).at(-1)).toEqual({
      kind: "node",
      id: "email",
      label: "Email service",
      selected: true,
    });
  });

  test("a selected container and the same container opened differ", () => {
    const selected = crumbsOf(deep, at(["A"], "A1"));
    const opened = crumbsOf(deep, at(["A", "A1"]));

    expect(selected.map((c) => (c.kind === "root" ? "root" : `${c.id} ${c.selected}`))).toEqual([
      "root",
      "A false",
      "A1 true",
    ]);

    expect(opened.map((c) => (c.kind === "root" ? "root" : `${c.id} ${c.selected}`))).toEqual([
      "root",
      "A false",
      "A1 false",
    ]);
  });

  test("the root's view alone is the root crumb", () => {
    expect(crumbsOf(sample, HOME)).toEqual([{ kind: "root" }]);
  });
});

describe("hashOf and placeOfHash", () => {
  test("a place a jump lands on keeps its bare #id", () => {
    expect(hashOf(sample, HOME)).toBe("");
    expect(hashOf(sample, at(["server", "app"]))).toBe("app");
    expect(hashOf(sample, at(["server", "app"], "orders"))).toBe("orders");
    expect(hashOf(sample, at([], "email"))).toBe("email");
  });

  test("a selected ghost or container carries the open view and the selection", () => {
    expect(hashOf(sample, at(["server", "app"], "email"))).toBe("app/email");
    expect(hashOf(deep, at(["A"], "A1"))).toBe("A/A1");
    expect(hashOf(sample, at([], "server"))).toBe("/server");
  });

  test("each id is percent-encoded, so a slash in an id cannot split it", () => {
    const tree = treeOf({
      root: {
        title: "T",
        children: [
          { id: "a/b", label: "x", sub: "", color: "c", children: [card("c d")] },
          { id: "e", label: "e", sub: "", color: "c", children: [card("f")] },
        ],
      },
      links: [{ from: "c d", to: "f", label: "l" }],
    });

    const place = at(["a/b"], "e");

    expect(hashOf(tree, place)).toBe("a%2Fb/e");
    expect(placeOfHash(tree, hashOf(tree, place))).toEqual(place);
    expect(placeOfHash(tree, "#c%20d")).toEqual(at(["a/b"], "c d"));
  });

  test("a bare #id reads as a jump", () => {
    expect(placeOfHash(deep, "#a1")).toEqual(at(["A", "A1", "A11", "A111"], "a1"));
    expect(placeOfHash(deep, "B111")).toEqual(at(["B", "B1", "B11", "B111"]));
    expect(placeOfHash(deep, "")).toBe(HOME);
  });

  test("a fragment that names nothing, or does not decode, opens the root's view", () => {
    for (const hash of ["#nowhere", "#nowhere/a1", "#a1/a2", "#%E0%A4%A", "#A/%E0%A4%A"]) {
      expect(placeOfHash(deep, hash)).toBe(HOME);
    }
  });

  test("a selection the open view does not show is dropped", () => {
    expect(placeOfHash(deep, "#A1/b1")).toEqual(at(["A", "A1"]));
  });
});

describe("a walk through every map", () => {
  test("the deep map's leaves are reached by entering one container per level", () => {
    const place = run(deep, HOME, [
      { type: "enter", id: "B" },
      { type: "enter", id: "B1" },
      { type: "enter", id: "B11" },
      { type: "enter", id: "B111" },
      { type: "select", id: "b1" },
    ]);

    expect(place).toEqual(navigate(deep, HOME, { type: "jump", id: "b1" }));

    expect(crumbsOf(deep, place).map((c) => (c.kind === "root" ? "root" : c.id))).toEqual([
      "root",
      "B",
      "B1",
      "B11",
      "B111",
      "b1",
    ]);
  });

  test.each([
    ["the sample", sample],
    ["the deep map", deep],
    ...[1, 2, 3, 5, 8, 13].map((seed): [string, Tree] => [
      `random map ${seed}`,
      treeOf(randomMap(seed)),
    ]),
  ])("%s: a jump to any node shows it, and escape leads home in one press per level", (_, tree) => {
    for (const [id, node] of tree.nodes) {
      const place = navigate(tree, HOME, { type: "jump", id });
      const view = viewOf(tree, openOf(place));
      const chain = chainOf(tree, id);

      if (node.children === undefined) {
        expect(place).toEqual(at(chain.slice(0, -1), id));
        expect(view.boxes.some((b) => b.id === id)).toBe(true);
      } else {
        expect(place).toEqual(at(chain));
      }

      const presses = place.path.length + (place.selected === null ? 0 : 1);
      const escapes = Array.from({ length: presses }, (): PlaceEvent => ({ type: "escape" }));

      expect(run(tree, place, escapes)).toEqual(HOME);
      expect(run(tree, place, escapes.slice(1))).not.toEqual(HOME);

      for (const item of [...view.boxes, ...view.ghosts]) {
        expect(navigate(tree, place, { type: "select", id: item.id }).selected).toBe(item.id);
      }
    }
  });

  test.each([
    ["the sample", sample],
    ["the deep map", deep],
    ...[1, 2, 3, 5, 8, 13].map((seed): [string, Tree] => [
      `random map ${seed}`,
      treeOf(randomMap(seed)),
    ]),
  ])("%s: every place survives its hash, and no two share a breadcrumb", (_, tree) => {
    const containers = [
      null,
      ...[...tree.nodes.values()].flatMap((n) => (n.children === undefined ? [] : [n.id])),
    ];

    const places = containers.flatMap((container) => {
      const view = viewOf(tree, container);
      const path = container === null ? [] : chainOf(tree, container);

      return [null, ...view.boxes, ...view.ghosts].map((item) => at(path, item?.id ?? null));
    });

    for (const place of places) {
      expect(placeOfHash(tree, `#${hashOf(tree, place)}`)).toEqual(place);
    }

    const crumbs = new Set(places.map((place) => JSON.stringify(crumbsOf(tree, place))));

    expect(crumbs.size).toBe(places.length);
  });
});
