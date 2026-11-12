import { describe, expect, test } from "bun:test";

import { pairsGraph, readPairs } from "./from-pairs.ts";

describe("readPairs", () => {
  test("reads tab, space and arrow lines, a lone name, and skips comments and blanks", () => {
    const text = "# deps\na.go\tb.go\nb.go -> c.go\nc.go d.go\n\nlonely.go\n";

    expect(readPairs(text)).toEqual([
      ["a.go", "b.go"],
      ["b.go", "c.go"],
      ["c.go", "d.go"],
      ["lonely.go", "lonely.go"],
    ]);
  });

  test("reads a madge object and a list of pairs", () => {
    expect(readPairs('{"a.ts": ["b.ts", "c.ts"], "b.ts": []}')).toEqual([
      ["a.ts", "b.ts"],
      ["a.ts", "c.ts"],
    ]);
    expect(readPairs('[["x", "y"]]')).toEqual([["x", "y"]]);
  });
});

describe("pairsGraph", () => {
  test("measures each name, counts the absent ones, and keeps each link once", () => {
    const pairs = [
      ["a", "b"],
      ["a", "b"],
      ["c", "c"],
      ["win\\path", "a"],
    ] as const;

    const sizes = new Map([
      ["a", 10],
      ["b", 3],
    ]);

    const { graph, absent } = pairsGraph(pairs, (path) => sizes.get(path) ?? null, "repo", "lines");

    expect(absent).toBe(2);
    expect(graph.nodes.map((node) => node.path)).toEqual(["a", "b", "c", "win/path"]);
    expect(graph.edges).toEqual([
      ["a", "b"],
      ["win/path", "a"],
    ]);
  });
});
