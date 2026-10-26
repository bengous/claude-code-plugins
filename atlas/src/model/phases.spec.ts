import { describe, expect, test } from "bun:test";

import type { AtlasMap, Node } from "./atlas.ts";
import type { Dimmed } from "./phases.ts";
import { arrowDimmed, dimmedBy } from "./phases.ts";
import { treeOf } from "./tree.ts";
import type { Arrow } from "./view.ts";
import { viewOf } from "./view.ts";

const PHASES = ["v1", "v2", "v3"];

const leaf = (id: string, phase?: string): Node => {
  const node: Node = { id, label: id, sub: "", color: "c" };

  return phase === undefined ? node : { ...node, phase };
};

const box = (id: string, children: readonly Node[], phase?: string): Node => ({
  ...leaf(id, phase),
  children,
});

const MAP: AtlasMap = {
  root: {
    title: "T",
    children: [
      box("A", [leaf("a1", "v1"), leaf("a2", "v2"), leaf("a3")]),
      box("B", [leaf("b1", "v2"), leaf("b2", "v3")]),
      box("C", [leaf("c1", "v1")], "v3"),
      box("D", [box("D1", [leaf("d1", "v3")]), leaf("d2", "v2")]),
      box("E", [box("E1", [leaf("e1", "v1")], "v3")]),
      leaf("x", "v9"),
    ],
  },
  links: [
    { from: "a1", to: "b1", label: "0", phase: "v1" },
    { from: "a2", to: "b2", label: "1", phase: "v3" },
    { from: "a3", to: "b1", label: "2" },
    { from: "a1", to: "d1", label: "3", phase: "v2" },
    { from: "a2", to: "d2", label: "4", phase: "v3" },
    { from: "x", to: "c1", label: "5", phase: "v9" },
  ],
};

const tree = treeOf(MAP);

const dimmed = (phase: string | null): Dimmed => dimmedBy(tree, PHASES, phase);

const sorted = <T>(set: ReadonlySet<T>): T[] => [...set].toSorted();

describe("dimmedBy", () => {
  test("a phase dims the nodes and links of the phases after it, not those of its own or before", () => {
    expect(sorted(dimmed("v2").nodes)).toEqual(["C", "D1", "E1", "b2", "d1"]);
    expect(sorted(dimmed("v2").links)).toEqual([1, 4]);
    expect(sorted(dimmed("v1").links)).toEqual([1, 3, 4]);
  });

  test("the last phase, or none picked, dims nothing", () => {
    for (const phase of ["v3", null]) {
      expect(dimmed(phase).nodes.size).toBe(0);
      expect(dimmed(phase).links.size).toBe(0);
    }
  });

  test("a node or a link without a phase, or with one the phases do not list, is never dimmed", () => {
    for (const phase of PHASES) {
      expect(dimmed(phase).nodes.has("a3")).toBe(false);
      expect(dimmed(phase).nodes.has("x")).toBe(false);
      expect(dimmed(phase).links.has(2)).toBe(false);
      expect(dimmed(phase).links.has(5)).toBe(false);
    }
  });

  test("a container is dimmed once all its descendants are, or its own phase comes after", () => {
    const v1 = dimmed("v1").nodes;

    expect(v1.has("B")).toBe(true);
    expect(v1.has("D1")).toBe(true);
    expect(v1.has("D")).toBe(true);
    expect(v1.has("C")).toBe(true);
    expect(v1.has("c1")).toBe(false);
    expect(v1.has("A")).toBe(false);

    const v2 = dimmed("v2").nodes;

    expect(v2.has("D1")).toBe(true);
    expect(v2.has("D")).toBe(false);
    expect(v2.has("B")).toBe(false);
  });

  test("a container whose child is dimmed by its own phase but holds a node that is not stays lit", () => {
    expect(dimmed("v1").nodes.has("E1")).toBe(true);
    expect(dimmed("v1").nodes.has("e1")).toBe(false);
    expect(dimmed("v1").nodes.has("E")).toBe(false);
  });

  test("a phase the phases do not list is refused", () => {
    expect(() => dimmed("v4")).toThrow("phase v4 is not one of the Config's phases (v1, v2, v3)");
  });
});

function arrow(container: string | null, from: string, to: string): Arrow {
  const found = viewOf(tree, container).arrows.find((a) => a.from === from && a.to === to);

  if (found === undefined) {
    throw new Error(`the view of ${container ?? "the root"} has no arrow ${from} → ${to}`);
  }

  return found;
}

describe("arrowDimmed", () => {
  test("a lifted arrow is dimmed only when every link it stands for is", () => {
    expect(arrow(null, "A", "B").links).toEqual([0, 1, 2]);
    expect(arrow(null, "A", "D").links).toEqual([3, 4]);

    expect(arrowDimmed(dimmed("v1"), arrow(null, "A", "B"))).toBe(false);
    expect(arrowDimmed(dimmed("v1"), arrow(null, "A", "D"))).toBe(true);
    expect(arrowDimmed(dimmed("v2"), arrow(null, "A", "D"))).toBe(false);
    expect(arrowDimmed(dimmed(null), arrow(null, "A", "D"))).toBe(false);
  });

  test("an arrow of one link is dimmed with it", () => {
    expect(arrow("A", "a2", "B").links).toEqual([1]);
    expect(arrowDimmed(dimmed("v2"), arrow("A", "a2", "B"))).toBe(true);
    expect(arrowDimmed(dimmed("v3"), arrow("A", "a2", "B"))).toBe(false);
  });
});
