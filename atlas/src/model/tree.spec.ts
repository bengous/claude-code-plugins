import { describe, expect, test } from "bun:test";

import SAMPLE from "../../fixtures/sample/map.ts";
import { DEEP } from "../../fixtures/trees.ts";
import type { AtlasMap, Journey, Node, Section, Step } from "./atlas.ts";
import {
  TreeError,
  chainOf,
  childrenOf,
  ghostIn,
  holds,
  itemIn,
  liftIn,
  openIn,
  subtreeOf,
  treeOf,
} from "./tree.ts";

const sample = treeOf(SAMPLE);

const deep = treeOf(DEEP);

const card = (id: string, extra: Partial<Node> = {}): Node => ({
  id,
  label: id,
  sub: "",
  color: "c",
  ...extra,
});

const mapOf = (children: readonly Node[], links: AtlasMap["links"] = []): AtlasMap => ({
  root: { title: "T", children },
  links,
});

const journeyed = (sections: readonly Section[]): AtlasMap => {
  const map = mapOf(
    [card("a", { children: [card("b"), card("c")] })],
    [{ from: "b", to: "c", label: "x" }],
  );

  return { ...map, root: { ...map.root, journeys: [{ id: "walk", label: "Walk", sections }] } };
};

const go = (from: string, to: string): Step => ({ from, to, trigger: "Go", kind: "manual" });

type Unchecked = {
  readonly id?: unknown;
  readonly label?: unknown;
  readonly steps?: unknown;
  readonly sections?: unknown;
};

const uncheckedJourneys = (given: readonly (Unchecked | null)[] | Unchecked): AtlasMap => {
  const map = journeyed([]);
  // SAFETY: journeys of any shape, a journey in the format before sections among them, as a map
  // folder's data can hold once it skips its typecheck.
  const journeys = given as readonly Journey[];

  return { ...map, root: { ...map.root, journeys } };
};

const unchecked = (journey: Unchecked): AtlasMap => uncheckedJourneys([journey]);

const refusal = (map: AtlasMap): string => {
  try {
    treeOf(map);
  } catch (error: unknown) {
    if (error instanceof TreeError) {
      return error.message;
    }

    throw error;
  }

  throw new Error("treeOf took the map");
};

describe("treeOf", () => {
  test("indexes every node depth-first, each with its chain from the root", () => {
    expect([...sample.nodes.keys()]).toEqual([
      "clients",
      "browser",
      "server",
      "proxy",
      "app",
      "web",
      "catalog",
      "orders",
      "data",
      "db",
      "backup",
      "email",
    ]);

    expect(chainOf(sample, "db")).toEqual(["server", "data", "db"]);
    expect(chainOf(deep, "a1")).toEqual(["A", "A1", "A11", "A111", "a1"]);
    expect(chainOf(deep, "b1")).toHaveLength(5);
  });

  test("counts the open points of each subtree, its own included", () => {
    expect([openIn(sample, "server"), openIn(sample, "data"), openIn(sample, "app")]).toEqual([
      1, 1, 0,
    ]);

    expect(
      ["a1", "A111", "A11", "A1", "A", "A12", "B", "b1"].map((id) => openIn(deep, id)),
    ).toEqual([1, 1, 2, 2, 2, 0, 2, 2]);
  });

  test("makes each coupling symmetric, its own couples first", () => {
    expect(sample.couplings.get("db")).toEqual(["catalog", "orders", "backup"]);
    expect(sample.couplings.get("orders")).toEqual(["db", "email"]);
    expect(sample.couplings.get("email")).toEqual(["orders"]);
    expect(deep.couplings.get("a1")).toEqual(["b2", "a5"]);
  });

  test("subtreeOf answers a node then its descendants, depth-first", () => {
    expect(subtreeOf(sample, "server")).toEqual([
      "server",
      "proxy",
      "app",
      "web",
      "catalog",
      "orders",
      "data",
      "db",
      "backup",
    ]);

    expect(subtreeOf(sample, "db")).toEqual(["db"]);
  });

  test("keeps the side of each outside node only", () => {
    expect([...sample.sides]).toEqual([
      ["clients", "in"],
      ["email", "out"],
    ]);
  });

  test.each([
    [
      "an empty id",
      mapOf([card("", { label: "Nameless", outside: true, side: "in" })]),
      'node "Nameless": its id is empty; an id names it in links and URLs',
    ],
    [
      "two nodes with one id",
      mapOf([card("a", { outside: true, side: "in" }), card("a", { outside: true, side: "in" })]),
      "node a: a second node has this id",
    ],
    [
      "an empty children",
      mapOf([card("a", { children: [] })]),
      "node a: children is empty; a leaf has no children field",
    ],
    [
      "a kind on a container",
      mapOf([card("a", { kind: "off", children: [card("b")] })]),
      "node a: kind is for a leaf; a container's children carry their own",
    ],
    [
      "side both on an outside container",
      mapOf([card("a", { outside: true, side: "both", children: [card("b")] })]),
      'node a: side "both" is for an outside leaf',
    ],
    [
      "an outside node below the root",
      mapOf([card("a", { children: [card("b", { outside: true, side: "in" })] })]),
      "node b: only a child of the root is outside",
    ],
    [
      "an outside node without a side",
      mapOf([card("a", { outside: true })]),
      "node a: an outside node needs a side",
    ],
    [
      "a side on a node inside",
      mapOf([card("a", { children: [card("b", { side: "out" })] })]),
      "node b: side is for an outside node",
    ],
    [
      "a coupling to an unknown node",
      mapOf([card("a", { children: [card("b", { couples: ["c"] })] })]),
      "node b: couples unknown node c",
    ],
    [
      "a link to an unknown node",
      mapOf([card("a", { children: [card("b")] })], [{ from: "b", to: "c", label: "x" }]),
      "link b → c: no node c",
    ],
    [
      "a link from a node to its own child",
      mapOf([card("a", { children: [card("b")] })], [{ from: "a", to: "b", label: "x" }]),
      "link a → b: one end holds the other; a link joins two nodes side by side",
    ],
    [
      "a link from a node to itself",
      mapOf([card("a", { children: [card("b")] })], [{ from: "b", to: "b", label: "x" }]),
      "link b → b: one end holds the other; a link joins two nodes side by side",
    ],
    [
      "a journey's step from an unknown node",
      journeyed([{ label: "Walk", steps: [go("nowhere", "b")] }]),
      "journey walk: step 1 (Walk), nowhere → b: no node nowhere",
    ],
    [
      "a journey's later step to an unknown node, numbered across the sections",
      journeyed([
        { label: "Out", steps: [go("b", "c")] },
        { label: "Back", steps: [go("c", "b"), { from: "b", to: "gone" }] },
      ]),
      "journey walk: step 3 (Back), b → gone: no node gone",
    ],
    [
      "a journey in the format before sections",
      unchecked({ id: "walk", label: "Walk", steps: [{ from: "b", to: "c" }] }),
      "journey walk: sections is not a list",
    ],
    [
      "a journey's section whose steps is no list",
      unchecked({
        id: "walk",
        label: "Walk",
        sections: [
          { label: "Out", steps: [go("b", "c")] },
          { label: "Back", steps: { from: "c", to: "b" } },
        ],
      }),
      "journey walk: section 2: steps is not a list",
    ],
    [
      "journeys that are no list",
      uncheckedJourneys({ id: "walk", label: "Walk", sections: [] }),
      "journeys is not a list",
    ],
    [
      "a journey that is no object",
      uncheckedJourneys([{ id: "walk", label: "Walk", sections: [] }, null]),
      "journey 2 is not an object",
    ],
    [
      "a journey without an id",
      uncheckedJourneys([{ label: "Walk", sections: [] }]),
      "journey 1: id is not text",
    ],
    [
      "a journey whose id is no text",
      uncheckedJourneys([{ id: 7, label: "Walk", sections: [] }]),
      "journey 1: id is not text",
    ],
    [
      "a journey without a label",
      uncheckedJourneys([{ id: "walk", sections: [] }]),
      "journey walk: label is not text",
    ],
    [
      "a journey whose label is no text",
      uncheckedJourneys([{ id: "walk", label: ["Walk"], sections: [] }]),
      "journey walk: label is not text",
    ],
    [
      "a journey's step whose kind is text but neither manual nor auto",
      unchecked({
        id: "walk",
        label: "Walk",
        sections: [
          { label: "Out", steps: [{ from: "b", to: "c", trigger: "Go", kind: "sometimes" }] },
        ],
      }),
      "journey walk: step 1 (Out), b → c: kind is not manual or auto",
    ],
    [
      "a journey's step that is no object",
      unchecked({
        id: "walk",
        label: "Walk",
        sections: [{ label: "Out", steps: [go("b", "c"), null] }],
      }),
      "journey walk: step 2 (Out) is not an object",
    ],
    [
      "a journey's section that is no object",
      unchecked({ id: "walk", label: "Walk", sections: [{ label: "Out", steps: [] }, null] }),
      "journey walk: section 2 is not an object",
    ],
    [
      "a journey's section without a label",
      unchecked({ id: "walk", label: "Walk", sections: [{ steps: [go("b", "c")] }] }),
      "journey walk: section 1: label is not text",
    ],
    [
      "a journey's section whose label is no text",
      unchecked({ id: "walk", label: "Walk", sections: [{ label: 3, steps: [go("b", "c")] }] }),
      "journey walk: section 1: label is not text",
    ],
    ...(["trigger", "kind", "carries", "when", "note"] as const).map(
      (field): [string, AtlasMap, string] => [
        `a journey's step whose ${field} is no text`,
        unchecked({
          id: "walk",
          label: "Walk",
          sections: [{ label: "Out", steps: [go("b", "c"), { from: "c", to: "b", [field]: 1 }] }],
        }),
        `journey walk: step 2 (Out), c → b: ${field} is not text`,
      ],
    ),
  ])("refuses %s", (_, map, message) => {
    expect(refusal(map)).toBe(message);
  });
});

describe("lifting", () => {
  test("liftIn answers the child of a container that is or holds a node, null below nothing", () => {
    expect(liftIn(sample, null, "db")).toBe("server");
    expect(liftIn(sample, "server", "db")).toBe("data");
    expect(liftIn(sample, "data", "db")).toBe("db");
    expect(liftIn(sample, "app", "db")).toBeNull();
    expect(liftIn(sample, "server", "server")).toBeNull();
    expect(liftIn(deep, "A1", "a1")).toBe("A11");
  });

  test("ghostIn answers the child of the lowest common ancestor that holds an outer node", () => {
    expect(ghostIn(sample, "app", "db")).toBe("data");
    expect(ghostIn(sample, "app", "email")).toBe("email");
    expect(ghostIn(sample, "data", "catalog")).toBe("app");
    expect(ghostIn(deep, "A111", "a4")).toBe("A12");
    expect(ghostIn(deep, "A111", "b1")).toBe("B");
    expect(ghostIn(deep, "B111", "a1")).toBe("A");
  });

  test("ghostIn answers null for a node below the container, the container, and its holders", () => {
    expect(ghostIn(sample, "app", "web")).toBeNull();
    expect(ghostIn(sample, "app", "app")).toBeNull();
    expect(ghostIn(sample, "app", "server")).toBeNull();
    expect(ghostIn(sample, null, "db")).toBeNull();
  });

  test("itemIn answers a child below the container, a ghost beside it", () => {
    expect(itemIn(sample, "app", "orders")).toBe("orders");
    expect(itemIn(sample, "app", "db")).toBe("data");
    expect(itemIn(sample, "app", "server")).toBeNull();
  });

  test("holds: a node holds itself and its descendants, the root holds every node", () => {
    expect(holds(sample, "server", "db")).toBe(true);
    expect(holds(sample, "db", "db")).toBe(true);
    expect(holds(sample, "db", "server")).toBe(false);
    expect(holds(sample, null, "email")).toBe(true);
  });

  test("childrenOf: the root's children for null, a container's own, and a leaf refused", () => {
    expect(childrenOf(sample, null).map((n) => n.id)).toEqual(["clients", "server", "email"]);
    expect(childrenOf(sample, "data").map((n) => n.id)).toEqual(["db", "backup"]);
    expect(() => childrenOf(sample, "db")).toThrow("node db is a leaf, not a container");
  });
});
