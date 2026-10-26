import type { LegendKey, Link, Node, Side } from "./atlas.ts";
import type { Tree } from "./tree.ts";
import {
  chainOf,
  childrenOf,
  couplingsOf,
  ghostIn,
  holds,
  isLeaf,
  itemIn,
  liftIn,
  openIn,
  subtreeOf,
} from "./tree.ts";

/** A child of a container box, named inside it. */
export type Chip = {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly off: boolean;
  /** Open points in its subtree, its own included. */
  readonly open: number;
};

type BoxBase = {
  readonly id: string;
  readonly label: string;
  readonly sub: string;
  readonly color: string;
  /** Open points in its subtree, its own included. */
  readonly open: number;
  /** An outside child of the root stands in the column(s) of its side; null: packed in the middle. */
  readonly column: Side | null;
  /** Its node's rank, the band it sits in; null when it has none. */
  readonly rank: number | null;
};

/** A leaf child: a card with its label and subtitle. */
export type LeafBox = BoxBase & { readonly kind: "leaf"; readonly off: boolean };

/** A container child: a frame naming its own children as chips. */
export type ContainerBox = BoxBase & {
  readonly kind: "container";
  readonly chips: readonly Chip[];
};

export type Box = LeafBox | ContainerBox;

/**
 * A node outside the open container that a link joins to a node inside, drawn at the edge: the
 * view's arrows come from a ghost in the left column ("in"), go to one in the right column ("out"),
 * and a ghost that does both stands in both ("both"), its arrows leaving the left copy and arriving
 * at the right one. A merged arrow counts in its own direction only.
 */
export type Ghost = {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly off: boolean;
  readonly open: number;
  readonly outside: boolean;
  readonly side: Side;
};

export type ArrowKind = "flow" | NonNullable<Link["kind"]>;

/**
 * One arrow per ordered pair of the view's boxes and ghosts that links join, each link's ends
 * lifted to the box or ghost that stands for them. A pair with a link carrying `two` gets a single
 * two-headed arrow for both directions. Its direction is that of the first link of the pair set
 * directly between the two and carrying `two`; else of the first set directly between them; else
 * of the first carrying `two`.
 */
export type Arrow = {
  readonly from: string;
  readonly to: string;
  /**
   * The labels of the links no other link of the arrow names, the first two joined: a link names
   * another when its ends hold the other's ends, at least one strictly, either way round in a
   * two-headed arrow. A link set directly between the pair names them all.
   */
  readonly label: string;
  /**
   * The kind shared by its links between two leaves, or by all its links when none joins two
   * leaves; "flow" when they differ.
   */
  readonly kind: ArrowKind;
  /** It stands for both directions: a link of the pair carries `two`. */
  readonly two: boolean;
  /** The tags of the links its kind is read from, each once. */
  readonly tags: readonly string[];
  /** The indexes in the map's links of the links it stands for, in map order. */
  readonly links: readonly number[];
  /** The nodes at an end of those links, each once: `lights` reads them. */
  readonly ends: readonly string[];
};

/** What the view of one container shows; `id` is null for the root's. */
export type View = {
  readonly id: string | null;
  /** Its children, in order. */
  readonly boxes: readonly Box[];
  /** In tree order, depth-first. */
  readonly ghosts: readonly Ghost[];
  /** In the order of the first link each stands for. */
  readonly arrows: readonly Arrow[];
  /**
   * The legend lines the view uses: the kinds its arrows draw, the marks its boxes and ghosts
   * carry, and "coupled" when selecting one of them outlines another.
   */
  readonly legend: Readonly<Record<LegendKey, boolean>>;
};

const LABELS_SHOWN = 2;

const LABEL_JOINT = " · ";

type Lifted = {
  readonly index: number;
  readonly link: Link;
  readonly from: string;
  readonly to: string;
};

function visibleItem(tree: Tree, container: string | null, link: Link, end: string): string {
  const item = itemIn(tree, container, end);

  if (item === null) {
    throw new Error(`link ${link.from} → ${link.to}: ${end} holds ${container ?? "the root"}`);
  }

  return item;
}

function liftedIn(tree: Tree, container: string | null): Lifted[] {
  return tree.map.links.flatMap((link, index): Lifted[] => {
    const from = liftIn(tree, container, link.from);
    const to = liftIn(tree, container, link.to);

    if (from === to) {
      return [];
    }

    return [
      {
        index,
        link,
        from: from ?? visibleItem(tree, container, link, link.from),
        to: to ?? visibleItem(tree, container, link, link.to),
      },
    ];
  });
}

const pairKey = (a: string, b: string): string => JSON.stringify(a < b ? [a, b] : [b, a]);

const endsKey = (from: string, to: string): string => JSON.stringify([from, to]);

function labelOf(tree: Tree, links: readonly Link[], two: boolean): string {
  const namers = new Set(links.map((l) => endsKey(l.from, l.to)));

  if (two) {
    for (const l of links) {
      namers.add(endsKey(l.to, l.from));
    }
  }

  const named = links.flatMap((inner) => {
    const tos = chainOf(tree, inner.to);

    const outer = chainOf(tree, inner.from).some((from) =>
      tos.some((to) => (from !== inner.from || to !== inner.to) && namers.has(endsKey(from, to))),
    );

    return outer ? [] : [inner.label];
  });

  return [...new Set(named)].slice(0, LABELS_SHOWN).join(LABEL_JOINT);
}

type Group = {
  readonly from: string;
  readonly to: string;
  readonly two: boolean;
  readonly members: Lifted[];
};

function arrowOf(tree: Tree, { from, to, two, members }: Group): Arrow {
  const links = members.map((m) => m.link);
  const leafward = links.filter((l) => isLeaf(tree, l.from) && isLeaf(tree, l.to));
  const flows = leafward.length > 0 ? leafward : links;
  const kinds = new Set(flows.map((l): ArrowKind => l.kind ?? "flow"));
  const [kind] = kinds;

  return {
    from,
    to,
    label: labelOf(tree, links, two),
    kind: kinds.size === 1 && kind !== undefined ? kind : "flow",
    two,
    tags: [...new Set(flows.flatMap((l) => l.tags ?? []))],
    links: members.map((m) => m.index),
    ends: [...new Set(links.flatMap((l) => [l.from, l.to]))],
  };
}

type Way = { readonly rank: number; readonly from: string; readonly to: string };

const DIRECT = 2;

const TWO = 1;

function mergedWays(lifted: readonly Lifted[]): Map<string, Way> {
  const twos = new Set(lifted.flatMap((l) => (l.link.two === true ? [pairKey(l.from, l.to)] : [])));
  const ways = new Map<string, Way>();

  for (const { link, from, to } of lifted) {
    const key = pairKey(from, to);
    const direct = link.from === from && link.to === to;
    const rank = (direct ? DIRECT : 0) + (link.two === true ? TWO : 0);

    if (twos.has(key) && rank > (ways.get(key)?.rank ?? 0)) {
      ways.set(key, { rank, from, to });
    }
  }

  return ways;
}

function arrowsOf(tree: Tree, lifted: readonly Lifted[]): Arrow[] {
  const ways = mergedWays(lifted);
  const groups = new Map<string, Group>();

  for (const l of lifted) {
    const way = ways.get(pairKey(l.from, l.to));
    const [from, to] = way === undefined ? [l.from, l.to] : [way.from, way.to];
    const key = JSON.stringify([from, to]);
    const group = groups.get(key) ?? { from, to, two: way !== undefined, members: [] };
    group.members.push(l);
    groups.set(key, group);
  }

  return [...groups.values()].map((g) => arrowOf(tree, g));
}

const chipOf = (tree: Tree, node: Node): Chip => ({
  id: node.id,
  label: node.label,
  color: node.color,
  off: node.kind === "off",
  open: openIn(tree, node.id),
});

function boxOf(tree: Tree, node: Node): Box {
  const base: BoxBase = {
    id: node.id,
    label: node.label,
    sub: node.sub,
    color: node.color,
    open: openIn(tree, node.id),
    column: tree.sides.get(node.id) ?? null,
    rank: node.rank ?? null,
  };

  return node.children === undefined
    ? { ...base, kind: "leaf", off: node.kind === "off" }
    : { ...base, kind: "container", chips: node.children.map((c) => chipOf(tree, c)) };
}

function ghostsOf(tree: Tree, children: ReadonlySet<string>, arrows: readonly Arrow[]): Ghost[] {
  const ins = new Set(arrows.flatMap((a) => (children.has(a.from) ? [] : [a.from])));
  const outs = new Set(arrows.flatMap((a) => (children.has(a.to) ? [] : [a.to])));

  return [...tree.nodes.values()].flatMap((node): Ghost[] => {
    const { id } = node;

    if (!ins.has(id) && !outs.has(id)) {
      return [];
    }

    const side: Side = ins.has(id) ? (outs.has(id) ? "both" : "in") : "out";

    return [
      {
        id,
        label: node.label,
        color: node.color,
        off: node.kind === "off",
        open: openIn(tree, id),
        outside: tree.sides.has(id),
        side,
      },
    ];
  });
}

function coupledAmong(
  tree: Tree,
  container: string | null,
  shown: ReadonlySet<string>,
  id: string,
): string[] {
  const self = itemIn(tree, container, id);

  const items = subtreeOf(tree, id).flatMap((held) =>
    couplingsOf(tree, held).flatMap((other) => {
      const item = itemIn(tree, container, other);

      return item !== null && item !== self && shown.has(item) ? [item] : [];
    }),
  );

  return [...new Set(items)];
}

/**
 * The view of a container: null for the root, or the id of a node with children. Its links are
 * those with an end below it: both ends below and in two children make an arrow between boxes,
 * one end below makes an arrow with a ghost, and both ends in one child show only in that child's
 * own view.
 */
export function viewOf(tree: Tree, container: string | null): View {
  const children = childrenOf(tree, container);
  const boxes = children.map((c) => boxOf(tree, c));
  const arrows = arrowsOf(tree, liftedIn(tree, container));
  const ghosts = ghostsOf(tree, new Set(children.map((c) => c.id)), arrows);
  const shown = new Set([...boxes.map((b) => b.id), ...ghosts.map((g) => g.id)]);

  return {
    id: container,
    boxes,
    ghosts,
    arrows,
    legend: {
      flow: arrows.some((a) => a.kind === "flow"),
      dash: arrows.some((a) => a.kind === "dash"),
      deny: arrows.some((a) => a.kind === "deny"),
      coupled: [...shown].some((id) => coupledAmong(tree, container, shown, id).length > 0),
      outside: boxes.some((b) => b.column !== null) || ghosts.some((g) => g.outside),
      open: boxes.some((b) => b.open > 0) || ghosts.some((g) => g.open > 0),
    },
  };
}

/**
 * The boxes and ghosts of a view to outline while `id` is selected: the nodes coupled, on either
 * side, with `id` or with a node it holds, each lifted to what stands for it in the view. So the
 * outline is symmetric once lifted: when selecting A outlines B, selecting B outlines A. A node
 * that nothing in the view stands for, or that `id`'s own box or ghost stands for, outlines
 * nothing.
 */
export function coupledIn(tree: Tree, view: View, id: string): readonly string[] {
  const shown = new Set([...view.boxes.map((b) => b.id), ...view.ghosts.map((g) => g.id)]);

  return coupledAmong(tree, view.id, shown, id);
}

/**
 * Whether the view of `container` shows `id`, as a box (a child) or as a ghost (a link joins a node
 * it holds to a node below the container), without building the view.
 */
export function showsIn(tree: Tree, container: string | null, id: string): boolean {
  if (!tree.nodes.has(id)) {
    return false;
  }

  if (liftIn(tree, container, id) === id) {
    return true;
  }

  return (
    ghostIn(tree, container, id) === id &&
    tree.map.links.some(
      ({ from, to }) =>
        (liftIn(tree, container, from) !== null && holds(tree, id, to)) ||
        (liftIn(tree, container, to) !== null && holds(tree, id, from)),
    )
  );
}

/** Whether selecting or hovering `id` lights the arrow: `id` is or holds an end of its links. */
export const lights = (tree: Tree, arrow: Arrow, id: string): boolean =>
  arrow.ends.some((end) => holds(tree, id, end));
