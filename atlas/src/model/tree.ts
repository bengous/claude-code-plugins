import type { AtlasMap, Node, Side } from "./atlas.ts";

export class TreeError extends Error {}

function refuse(message: string): never {
  throw new TreeError(message);
}

function fail(message: string): never {
  throw new Error(message);
}

/**
 * A map indexed for its views. Wherever a container is expected, null stands for the root, which
 * has no id.
 */
export type Tree = {
  readonly map: AtlasMap;
  /** Every node, depth-first: a node before its children, children in order. */
  readonly nodes: ReadonlyMap<string, Node>;
  /** Each node's ids from a child of the root down to the node itself. */
  readonly chains: ReadonlyMap<string, readonly string[]>;
  /** Every id, depth-first, as `nodes` holds them. */
  readonly order: readonly string[];
  /** Where each node's subtree lies in `order`, [start, end): the node, then its descendants. */
  readonly spans: ReadonlyMap<string, readonly [number, number]>;
  /** Each node's open points, those of its descendants included. */
  readonly open: ReadonlyMap<string, number>;
  /** Each node's couplings, declared on either side. */
  readonly couplings: ReadonlyMap<string, readonly string[]>;
  /** The side of each outside node, and of no other. */
  readonly sides: ReadonlyMap<string, Side>;
};

export function nodeOf(tree: Tree, id: string): Node {
  return tree.nodes.get(id) ?? fail(`no node ${id}`);
}

export function chainOf(tree: Tree, id: string): readonly string[] {
  return tree.chains.get(id) ?? fail(`no node ${id}`);
}

export function childrenOf(tree: Tree, container: string | null): readonly Node[] {
  if (container === null) {
    return tree.map.root.children;
  }

  return nodeOf(tree, container).children ?? fail(`node ${container} is a leaf, not a container`);
}

export const isLeaf = (tree: Tree, id: string): boolean => nodeOf(tree, id).children === undefined;

export const openIn = (tree: Tree, id: string): number =>
  tree.open.get(id) ?? fail(`no node ${id}`);

export const couplingsOf = (tree: Tree, id: string): readonly string[] =>
  tree.couplings.get(id) ?? fail(`no node ${id}`);

/** The node and its descendants, depth-first. */
export function subtreeOf(tree: Tree, id: string): readonly string[] {
  const [start, end] = tree.spans.get(id) ?? fail(`no node ${id}`);

  return tree.order.slice(start, end);
}

/** Whether `holder` is `id` or one of its ancestors; the root holds every node. */
export const holds = (tree: Tree, holder: string | null, id: string): boolean =>
  holder === null || chainOf(tree, id).includes(holder);

const depthOf = (tree: Tree, container: string | null): number =>
  container === null ? 0 : chainOf(tree, container).length;

/** The child of `container` that is or holds `id`; null when `id` is not below `container`. */
export function liftIn(tree: Tree, container: string | null, id: string): string | null {
  const chain = chainOf(tree, id);
  const depth = depthOf(tree, container);

  if (chain.length <= depth || (container !== null && chain[depth - 1] !== container)) {
    return null;
  }

  return chain[depth] ?? null;
}

/**
 * Where `id` stands beside the view of `container` when it is not below it: the child of their
 * lowest common ancestor that holds it. Null when `id` is below `container`, is it, or holds it.
 */
export function ghostIn(tree: Tree, container: string | null, id: string): string | null {
  if (container === null) {
    return null;
  }

  const inside = chainOf(tree, container);
  const chain = chainOf(tree, id);
  const common = chain.findIndex((step, i) => inside[i] !== step);

  if (common === -1 || common >= inside.length) {
    return null;
  }

  return chain[common] ?? null;
}

/** What stands for `id` in the view of `container`: a child, a ghost, or nothing. */
export const itemIn = (tree: Tree, container: string | null, id: string): string | null =>
  liftIn(tree, container, id) ?? ghostIn(tree, container, id);

/**
 * Indexes a map, and refuses what its views cannot show: an empty id, two nodes with one id, an
 * empty `children`, a `kind` or a side "both" on a container, an outside node below the root or without
 * a side, a side on a node inside, a rank that is not an integer from 0, a coupling or a link to
 * an unknown node, and a link whose one end holds the other.
 */
export function treeOf(map: AtlasMap): Tree {
  const nodes = new Map<string, Node>();
  const chains = new Map<string, readonly string[]>();
  const order: string[] = [];
  const spans = new Map<string, readonly [number, number]>();
  const open = new Map<string, number>();
  const sides = new Map<string, Side>();

  const visit = (node: Node, above: readonly string[]): number => {
    const { id, children, outside, side, rank } = node;

    if (id === "") {
      refuse(`node "${node.label}": its id is empty; an id names it in links and URLs`);
    }

    if (nodes.has(id)) {
      refuse(`node ${id}: a second node has this id`);
    }

    if (children?.length === 0) {
      refuse(`node ${id}: children is empty; a leaf has no children field`);
    }

    if (children !== undefined && node.kind !== undefined) {
      refuse(`node ${id}: kind is for a leaf; a container's children carry their own`);
    }

    if (children !== undefined && side === "both") {
      refuse(`node ${id}: side "both" is for an outside leaf`);
    }

    if (outside === true) {
      if (above.length > 0) {
        refuse(`node ${id}: only a child of the root is outside`);
      }

      sides.set(id, side ?? refuse(`node ${id}: an outside node needs a side`));
    } else if (side !== undefined) {
      refuse(`node ${id}: side is for an outside node`);
    }

    if (rank !== undefined && !(Number.isInteger(rank) && rank >= 0)) {
      const shown = Object.is(Number(rank), rank) ? String(rank) : JSON.stringify(rank);
      refuse(
        `node ${id}: rank ${shown} is not an integer from 0; give 0 to the first band, 1 to the next, or no rank`,
      );
    }

    const chain = [...above, id];
    const start = order.length;
    nodes.set(id, node);
    chains.set(id, chain);
    order.push(id);
    const below = (children ?? []).reduce((sum, child) => sum + visit(child, chain), 0);
    const total = below + (node.open?.length ?? 0);
    open.set(id, total);
    spans.set(id, [start, order.length]);

    return total;
  };

  for (const child of map.root.children) {
    visit(child, []);
  }

  const declaredBy = new Map<string, string[]>();

  for (const node of nodes.values()) {
    for (const other of node.couples ?? []) {
      if (!nodes.has(other)) {
        refuse(`node ${node.id}: couples unknown node ${other}`);
      }

      const list = declaredBy.get(other) ?? [];
      list.push(node.id);
      declaredBy.set(other, list);
    }
  }

  const couplings = new Map(
    [...nodes.values()].map((node): [string, readonly string[]] => {
      const both = new Set([...(node.couples ?? []), ...(declaredBy.get(node.id) ?? [])]);
      both.delete(node.id);

      return [node.id, [...both]];
    }),
  );

  const tree: Tree = { map, nodes, chains, order, spans, open, couplings, sides };

  for (const { from, to } of map.links) {
    for (const end of [from, to]) {
      if (!nodes.has(end)) {
        refuse(`link ${from} → ${to}: no node ${end}`);
      }
    }

    if (holds(tree, from, to) || holds(tree, to, from)) {
      refuse(`link ${from} → ${to}: one end holds the other; a link joins two nodes side by side`);
    }
  }

  return tree;
}
