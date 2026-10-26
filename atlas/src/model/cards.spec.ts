import { describe, expect, test } from "bun:test";

import SAMPLE from "../../fixtures/sample/map.ts";
import { DEEP } from "../../fixtures/trees.ts";
import type { Node } from "./atlas.ts";
import { cardsOf } from "./cards.ts";
import { treeOf } from "./tree.ts";

const leaf = (id: string, fields: Partial<Node> = {}): Node => ({
  id,
  label: id,
  sub: "",
  color: "c",
  ...fields,
});

const rootOf = (children: readonly Node[]) => treeOf({ root: { title: "T", children }, links: [] });

describe("cardsOf", () => {
  test("one column per leaf child, in data order; a container child has none", () => {
    const tree = rootOf([
      leaf("b", { io: [["Receives", "x"]] }),
      { ...leaf("box"), children: [leaf("inner", { io: [["Receives", "y"]] }), leaf("other")] },
      leaf("a"),
    ]);

    expect(cardsOf(tree, null)?.columns.map((column) => column.id)).toEqual(["b", "a"]);
    expect(cardsOf(tree, "box")?.columns.map((column) => column.id)).toEqual(["inner", "other"]);
  });

  test("a container of one leaf has none, whatever its io and its container children", () => {
    const tree = rootOf([
      leaf("only", { io: [["Receives", "x"]] }),
      { ...leaf("box"), children: [leaf("inner", { io: [["Receives", "y"]] })] },
    ]);

    expect(cardsOf(tree, null)).toBeNull();
    expect(cardsOf(tree, "box")).toBeNull();
  });

  test("a first row holds each leaf's lead, then one row per key, in first-seen order", () => {
    const tree = rootOf([
      leaf("p", {
        lead: "P does",
        io: [
          ["Produces", "p1"],
          ["Receives", "p2"],
        ],
      }),
      leaf("q", {
        io: [
          ["Receives", "q1"],
          ["Emits", "q2"],
        ],
      }),
    ]);

    const cards = cardsOf(tree, null);

    expect(cards?.lead).toEqual(["P does", null]);
    expect(cards?.rows.map((row) => row.key)).toEqual(["Produces", "Receives", "Emits"]);
  });

  test("no row of leads when no leaf has one, an empty lead counted as none", () => {
    const tree = rootOf([
      leaf("p", { lead: "", io: [["Receives", "a"]] }),
      leaf("q", { io: [["Receives", "b"]] }),
    ]);

    expect(cardsOf(tree, null)?.lead).toBeNull();
  });

  test("pairs sharing a first element join in one cell, in their order", () => {
    const tree = rootOf([
      leaf("p", {
        io: [
          ["Receives", "a"],
          ["Produces", "b"],
          ["Receives", "c"],
        ],
      }),
      leaf("q"),
    ]);

    expect(cardsOf(tree, null)?.rows).toEqual([
      { key: "Receives", cells: [["a", "c"], []] },
      { key: "Produces", cells: [["b"], []] },
    ]);
  });

  test("a leaf missing a key gets an empty cell", () => {
    const tree = rootOf([
      leaf("p", { io: [["Receives", "a"]] }),
      leaf("q", { io: [["Produces", "b"]] }),
      leaf("r"),
    ]);

    expect(cardsOf(tree, null)?.rows).toEqual([
      { key: "Receives", cells: [["a"], [], []] },
      { key: "Produces", cells: [[], ["b"], []] },
    ]);
  });

  test("a container whose leaves have no io, an empty io included, or that has no leaf, has none", () => {
    expect(cardsOf(rootOf([leaf("p"), leaf("q", { io: [] })]), null)).toBeNull();
    expect(cardsOf(rootOf([{ ...leaf("box"), children: [leaf("p")] }]), null)).toBeNull();

    const deep = treeOf(DEEP);

    for (const [id, node] of deep.nodes) {
      if (node.children !== undefined) {
        expect(cardsOf(deep, id)).toBeNull();
      }
    }
  });

  test("the sample: the application's three bricks side by side; the root's one leaf has none", () => {
    const sample = treeOf(SAMPLE);
    const app = cardsOf(sample, "app");

    expect(app?.columns.map((column) => column.id)).toEqual(["web", "catalog", "orders"]);
    expect(app?.rows.map((row) => row.key)).toEqual(["Receives", "Produces"]);
    expect(app?.rows[0]?.cells).toEqual([
      ["HTTP requests"],
      ["a search or a book id"],
      ["a cart and a delivery address"],
    ]);
    expect(cardsOf(sample, null)).toBeNull();
    expect(cardsOf(sample, "data")).toBeNull();
  });
});
