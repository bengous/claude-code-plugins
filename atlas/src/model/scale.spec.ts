import { expect, test } from "bun:test";

import type { AtlasMap, Link, Node } from "./atlas.ts";
import { navigate } from "./navigation.ts";
import { treeOf } from "./tree.ts";
import { viewOf } from "./view.ts";

const SIDES = 2;

const GROUPS = 50;

const LEAVES = 50;

const card = (id: string, extra: Partial<Node> = {}): Node => ({
  id,
  label: id,
  sub: "",
  color: "c",
  ...extra,
});

const leafId = (side: number, group: number, leaf: number): string => `l${side}-${group}-${leaf}`;

function wideMap(): AtlasMap {
  const children = Array.from({ length: SIDES }, (_, side) =>
    card(`s${side}`, {
      children: Array.from({ length: GROUPS }, (__, group) =>
        card(`g${side}-${group}`, {
          children: Array.from({ length: LEAVES }, (___, leaf) =>
            card(leafId(side, group, leaf), {
              couples: [leafId(1 - side, (group * 7) % GROUPS, leaf)],
            }),
          ),
        }),
      ),
    }),
  );

  const links = Array.from({ length: GROUPS * LEAVES }, (_, i): Link[] => {
    const [group, leaf] = [Math.floor(i / LEAVES), i % LEAVES];
    const far = leafId(1, (group * 13 + leaf) % GROUPS, (leaf * 17) % LEAVES);

    return [
      { from: leafId(0, group, leaf), to: far, label: `go ${i}` },
      { from: far, to: leafId(0, group, (leaf + 1) % LEAVES), label: `back ${i}` },
    ];
  }).flat();

  return { root: { title: "wide", children }, links };
}

test("a map of 5,000 nodes and 5,000 links is indexed, viewed and navigated in well under a second", () => {
  const map = wideMap();
  const started = performance.now();
  const tree = treeOf(map);
  const root = viewOf(tree, null);
  const group = viewOf(tree, "g0-0");
  const ghost = group.ghosts[0]?.id ?? "";

  const place = navigate(
    tree,
    { path: ["s0", "g0-0"], selected: null },
    { type: "select", id: ghost },
  );

  const elapsed = performance.now() - started;

  expect(tree.nodes.size).toBe(SIDES * (1 + GROUPS * (1 + LEAVES)));
  expect(root.arrows.map((a) => a.links.length)).toEqual([GROUPS * LEAVES, GROUPS * LEAVES]);
  expect(place.selected).toBe(ghost);
  expect(elapsed).toBeLessThan(1000);
});
