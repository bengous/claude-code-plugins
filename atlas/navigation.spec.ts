import { describe, expect, test } from "bun:test";

import SAMPLE from "./fixtures/sample/map.ts";
import { DEEP, randomMap } from "./fixtures/trees.ts";
import type { Place, PlaceEvent } from "./navigation.ts";
import { HOME, crumbsOf, navigate, openOf } from "./navigation.ts";
import type { Tree } from "./tree.ts";
import { chainOf, treeOf } from "./tree.ts";
import { viewOf } from "./view.ts";

const sample = treeOf(SAMPLE);

const deep = treeOf(DEEP);

const run = (tree: Tree, place: Place, events: readonly PlaceEvent[]): Place =>
  events.reduce((at, event) => navigate(tree, at, event), place);

const at = (path: readonly string[], selected: string | null = null): Place => ({ path, selected });

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
  test("the root, the path, then a selected box", () => {
    expect(crumbsOf(sample, at(["server", "app"], "orders"))).toEqual([
      { kind: "root" },
      { kind: "node", id: "server", label: "Server" },
      { kind: "node", id: "app", label: "Application" },
      { kind: "node", id: "orders", label: "Orders" },
    ]);
  });

  test("a selected ghost stays off the breadcrumb: it is not on the path", () => {
    expect(crumbsOf(sample, at(["server", "app"], "email"))).toEqual([
      { kind: "root" },
      { kind: "node", id: "server", label: "Server" },
      { kind: "node", id: "app", label: "Application" },
    ]);
  });

  test("the root's view alone is the root crumb", () => {
    expect(crumbsOf(sample, HOME)).toEqual([{ kind: "root" }]);
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
});
