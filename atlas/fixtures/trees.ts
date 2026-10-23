import type { AtlasMap, Link, Node, OpenPoint, Side } from "../src/model/atlas.ts";

type Extra = Omit<Partial<Node>, "id" | "children">;

const leaf = (id: string, extra: Extra = {}): Node => ({
  id,
  label: id,
  sub: `${id} sub`,
  color: id.slice(0, 1).toLowerCase(),
  ...extra,
});

const box = (id: string, children: readonly Node[], extra: Extra = {}): Node => ({
  ...leaf(id, extra),
  children,
});

const point = (id: string): OpenPoint => ({
  id,
  text: `${id} is unsettled`,
});

/**
 * A map five levels deep: a1 and b1 sit at depth 5. Its links join nodes at every level, across
 * branches, both ways, toward and from outside nodes, and some name the arrows of others.
 */
export const DEEP = {
  root: {
    title: "Deep",
    children: [
      box("A", [
        box("A1", [
          box(
            "A11",
            [
              box("A111", [leaf("a1", { couples: ["b2"], open: [point("a1-open")] }), leaf("a2")]),
              leaf("a3"),
            ],
            { open: [point("a11-open")] },
          ),
          box("A12", [leaf("a4"), leaf("a5", { couples: ["a1"] })]),
        ]),
        box("A2", [leaf("a6", { kind: "off" })]),
      ]),
      box("B", [
        box("B1", [
          box("B11", [
            box("B111", [
              leaf("b1", { open: [point("b1-first"), point("b1-second")] }),
              leaf("b2"),
            ]),
          ]),
        ]),
        leaf("b3"),
      ]),
      leaf("X", { outside: true, side: "both", couples: ["a3"] }),
      box("Y", [leaf("y1", { couples: ["b3"] })], { outside: true, side: "in" }),
    ],
  },
  links: [
    { from: "a1", to: "a2", label: "inner" },
    { from: "a1", to: "a3", label: "up one" },
    { from: "a1", to: "a4", label: "cousin" },
    { from: "a5", to: "a2", label: "back" },
    { from: "a1", to: "b1", label: "far", tags: ["t1"] },
    { from: "b2", to: "a5", label: "far back", kind: "deny" },
    { from: "A", to: "B", label: "sync", two: true },
    { from: "a3", to: "a6", label: "q" },
    { from: "a4", to: "a6", label: "r" },
    { from: "A1", to: "A2", label: "to A2" },
    { from: "a1", to: "X", label: "p1" },
    { from: "a3", to: "X", label: "p2", kind: "dash" },
    { from: "a6", to: "X", label: "p3" },
    { from: "X", to: "a2", label: "push" },
    { from: "y1", to: "a3", label: "feed" },
    { from: "b3", to: "b1", label: "local", kind: "dash" },
    { from: "b2", to: "b1", label: "reply" },
    { from: "b1", to: "b2", label: "pair", two: true },
    { from: "A12", to: "a6", label: "feeds a6" },
  ],
} satisfies AtlasMap;

const SIDES: readonly Side[] = ["in", "out", "both"];

const KINDS = ["flow", "flow", "flow", "dash", "deny"] as const;

const MODULUS = 2_147_483_647;

/** How wide a random map grows: children per container at most, and links tried. */
export type Growth = { readonly fanout: number; readonly links: number };

const SMALL: Growth = { fanout: 3, links: 30 };

/**
 * A map drawn from a seed, the same for the same seed and growth: nodes up to five levels deep, an
 * outside leaf, couplings, open points, and links between nodes that do not hold each other.
 */
export function randomMap(seed: number, growth: Growth = SMALL): AtlasMap {
  let state = (seed % (MODULUS - 1)) + 1;

  const next = (): number => {
    state = (state * 48_271) % MODULUS;

    return state / MODULUS;
  };

  const pick = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(next() * items.length)];

    if (item === undefined) {
      throw new Error("randomMap: nothing to pick from");
    }

    return item;
  };

  const chains = new Map<string, readonly string[]>();
  const leaves: string[] = [];

  const grow = (above: readonly string[]): Node => {
    const id = `n${chains.size}`;
    const chain = [...above, id];
    chains.set(id, chain);
    const extra: Extra = next() < 0.2 ? { open: [point(`${id}-open`)] } : {};

    if (chain.length === 5 || (chain.length > 1 && next() < 0.35)) {
      leaves.push(id);

      return leaf(id, extra);
    }

    const size = 1 + Math.floor(next() * growth.fanout);

    return box(
      id,
      Array.from({ length: size }, () => grow(chain)),
      extra,
    );
  };

  const inside = Array.from({ length: 2 + Math.floor(next() * 2) }, () => grow([]));
  chains.set("out", ["out"]);
  leaves.push("out");

  const couple = (node: Node): Node => {
    if (node.children !== undefined) {
      return { ...node, children: node.children.map((child) => couple(child)) };
    }

    return next() < 0.3 ? { ...node, couples: [pick(leaves)] } : node;
  };

  const entries = [...chains];

  const links = Array.from({ length: growth.links }, (): Link[] => {
    const [from, fromChain] = pick(entries);
    const [to, toChain] = pick(entries);

    if (fromChain.includes(to) || toChain.includes(from)) {
      return [];
    }

    const plain = { from, to, label: `${from}-${to}` };
    const kind = pick(KINDS);
    const kinded: Link = kind === "flow" ? plain : { ...plain, kind };

    return [next() < 0.15 ? { ...kinded, two: true } : kinded];
  }).flat();

  return {
    root: {
      title: `random ${seed}`,
      children: [
        ...inside.map((node) => couple(node)),
        couple({ ...leaf("out"), outside: true, side: pick(SIDES) }),
      ],
    },
    links,
  };
}
