import type { LegendKey, Link, Node, Side } from "./atlas.ts";
import type { Tree } from "./tree.ts";
import {
  childrenOf,
  couplingsOf,
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
  readonly open: number;
  readonly outside: boolean;
  readonly side: Side;
};

export type ArrowKind = "flow" | NonNullable<Link["kind"]>;

/**
 * One arrow per ordered pair of the view's boxes and ghosts that links join, each link's ends
 * lifted to the box or ghost that stands for them. A link set directly between the pair with `two`
 * merges both directions into its own, two-headed.
 */
export type Arrow = {
  readonly from: string;
  readonly to: string;
  /**
   * The labels of the links no other link of the arrow names, the first two joined: a link names
   * another when its ends hold the other's ends, at least one strictly, either way round for a
   * link with `two`. A link set directly between the pair names them all.
   */
  readonly label: string;
  /** The kind shared by its links between two leaves; "flow" when they differ or there are none. */
  readonly kind: ArrowKind;
  readonly two: boolean;
  /** The tags of its links between two leaves, each once. */
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

const names = (tree: Tree, outer: Link, inner: Link): boolean =>
  (holds(tree, outer.from, inner.from) &&
    holds(tree, outer.to, inner.to) &&
    (outer.from !== inner.from || outer.to !== inner.to)) ||
  (outer.two === true &&
    holds(tree, outer.from, inner.to) &&
    holds(tree, outer.to, inner.from) &&
    (outer.from !== inner.to || outer.to !== inner.from));

function labelOf(tree: Tree, links: readonly Link[]): string {
  const named = links.flatMap((inner) =>
    links.some((outer) => names(tree, outer, inner)) ? [] : [inner.label],
  );

  return [...new Set(named)].slice(0, LABELS_SHOWN).join(LABEL_JOINT);
}

function arrowOf(tree: Tree, from: string, to: string, members: readonly Lifted[]): Arrow {
  const links = members.map((m) => m.link);
  const flows = links.filter((l) => isLeaf(tree, l.from) && isLeaf(tree, l.to));
  const kinds = new Set(flows.map((l): ArrowKind => l.kind ?? "flow"));
  const [kind] = kinds;

  return {
    from,
    to,
    label: labelOf(tree, links),
    kind: kinds.size === 1 && kind !== undefined ? kind : "flow",
    two: links.some((l) => l.two === true),
    tags: [...new Set(flows.flatMap((l) => l.tags ?? []))],
    links: members.map((m) => m.index),
    ends: [...new Set(links.flatMap((l) => [l.from, l.to]))],
  };
}

function arrowsOf(tree: Tree, lifted: readonly Lifted[]): Arrow[] {
  const merged = new Map<string, readonly [string, string]>();

  for (const { link, from, to } of lifted) {
    const key = pairKey(from, to);

    if (link.two === true && link.from === from && link.to === to && !merged.has(key)) {
      merged.set(key, [from, to]);
    }
  }

  const groups = new Map<string, { from: string; to: string; members: Lifted[] }>();

  for (const l of lifted) {
    const [from, to] = merged.get(pairKey(l.from, l.to)) ?? [l.from, l.to];
    const key = JSON.stringify([from, to]);
    const group = groups.get(key) ?? { from, to, members: [] };
    group.members.push(l);
    groups.set(key, group);
  }

  return [...groups.values()].map((g) => arrowOf(tree, g.from, g.to, g.members));
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

/** Whether selecting or hovering `id` lights the arrow: `id` is or holds an end of its links. */
export const lights = (tree: Tree, arrow: Arrow, id: string): boolean =>
  arrow.ends.some((end) => holds(tree, id, end));
