import type { AtlasMap, Config, Link, Node } from "./atlas.ts";
import type { Brick, Edge, Plan, Zone } from "./model.ts";

function fail(message: string): never {
  throw new Error(message);
}

// The engine draws a Plan on two levels: zones, the nodes with children, and bricks, the leaves.
// toPlan turns a map's tree into one, and refuses a tree that engine cannot draw, naming the node
// or the link at fault.
export function toPlan(map: AtlasMap, config: Config): Plan {
  const zones: Zone[] = [];
  const bricks: Brick[] = [];
  const ids = new Set<string>();

  const visit = (n: Node, parent: string | null): void => {
    const { id, label, title, sub, color, brief, couples, kind, side, outside, children, ...rest } =
      n;

    if (ids.has(id)) {
      fail(`node ${id}: a second node has this id`);
    }

    ids.add(id);

    if (outside === true && parent !== null) {
      fail(`node ${id}: only a child of the root is outside`);
    }

    if (side !== undefined && outside !== true) {
      fail(`node ${id}: side is for an outside node`);
    }

    const token = config.palette[color] ?? fail(`node ${id}: color ${color} is not in the palette`);
    const info = { title: title ?? label, ...rest };

    if (children === undefined) {
      if (parent === null && outside !== true) {
        fail(
          `node ${id}: a leaf under the root must be outside; otherwise it sits in a node with children`,
        );
      }

      if (brief !== undefined) {
        fail(`node ${id}: brief is for a node with children`);
      }

      const options: { -readonly [Key in "kind" | "side"]?: Brick[Key] } = {};

      if (kind !== undefined) {
        options.kind = kind;
      }

      if (side !== undefined) {
        options.side = side;
      }

      bricks.push({
        id,
        zone: parent,
        label,
        sub,
        info,
        color: token,
        couples: couples ?? [],
        ...options,
      });

      return;
    }

    if (children.length === 0) {
      fail(`node ${id}: children is empty; a leaf has no children field`);
    }

    if (couples !== undefined || kind !== undefined) {
      fail(`node ${id}: couples and kind are for a leaf`);
    }

    if (side === "both") {
      fail(`node ${id}: side "both" is for an outside leaf`);
    }

    const nested = children.find((c) => c.children !== undefined);

    if (outside === true && nested !== undefined) {
      fail(`node ${id}: an outside node holds leaves only, and ${nested.id} has children`);
    }

    if (parent === null && outside !== true && nested === undefined) {
      fail(
        `node ${id}: a node under the root that is not outside needs a child with children: the overview draws its own leaves in a block beside those (${id}~own)`,
      );
    }

    const options: { -readonly [Key in "parent" | "ext" | "side"]?: Zone[Key] } = {};

    if (parent !== null) {
      options.parent = parent;
    }

    if (outside === true) {
      options.ext = true;
    }

    if (side !== undefined) {
      options.side = side;
    }

    zones.push({ id, title: label, tag: sub, color: token, kw: brief ?? [], info, ...options });

    for (const child of children) {
      visit(child, id);
    }
  };

  const { tour, children, ...overview } = map.root;

  for (const child of children) {
    visit(child, null);
  }

  const zoneIds = new Set(zones.map((z) => z.id));

  const end = (link: Link, id: string): string => {
    if (zoneIds.has(id)) {
      return `z:${id}`;
    }

    return ids.has(id) ? id : fail(`link ${link.from} → ${link.to}: no node ${id}`);
  };

  const edges = map.links.map((link): Edge => {
    const { from, to, tags, ...rest } = link;
    const edge = { from: end(link, from), to: end(link, to), ...rest };

    return tags === undefined ? edge : { ...edge, data: tags };
  });

  return {
    overview,
    zones,
    nodes: bricks,
    edges,
    zoneOrder: tour ?? zones.map((z) => z.id),
  };
}
