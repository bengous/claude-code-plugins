import { join, resolve } from "node:path";

import type { AtlasMap, Link, Node } from "./atlas.ts";
import { MAP_FILE } from "./folder.ts";

// One node of a map folder as the agent reads it, without a browser:
//   bun atlas/query.ts <map folder> <node id>   prints the node as JSON
export type Named = { readonly id: string; readonly label: string };

export type Arrow = Omit<Link, "from" | "to"> & { readonly node: Named };

export type NodeAnswer = {
  readonly map: string;
  // From the root's first level down to the node itself.
  readonly path: readonly Named[];
  readonly children: readonly Named[];
  readonly outgoing: readonly Arrow[];
  readonly incoming: readonly Arrow[];
  // Every field the node sets but its id, label and children: its panel, open points included.
  readonly fields: Omit<Node, "id" | "label" | "children">;
  readonly sources: readonly string[];
};

export class QueryError extends Error {}

const named = ({ id, label }: Node): Named => ({ id, label });

function pathTo(nodes: readonly Node[], id: string): Node[] | null {
  for (const node of nodes) {
    if (node.id === id) {
      return [node];
    }

    const below = pathTo(node.children ?? [], id);

    if (below !== null) {
      return [node, ...below];
    }
  }

  return null;
}

function everyNode(nodes: readonly Node[]): Node[] {
  return nodes.flatMap((node) => [node, ...everyNode(node.children ?? [])]);
}

export function queryNode(map: AtlasMap, id: string): NodeAnswer {
  const path = pathTo(map.root.children, id);
  const node = path?.at(-1);

  if (path === null || node === undefined) {
    throw new QueryError(`no node ${id} in the map`);
  }

  const byId = new Map(everyNode(map.root.children).map((n) => [n.id, n]));

  const end = (other: string): Named => {
    const found = byId.get(other);

    return found === undefined ? { id: other, label: other } : named(found);
  };

  const arrow = ({ from: _from, to: _to, ...rest }: Link, other: string): Arrow => ({
    ...rest,
    node: end(other),
  });

  const { id: _id, label: _label, children, ...fields } = node;

  return {
    map: map.root.title,
    path: path.map((n) => named(n)),
    children: (children ?? []).map((n) => named(n)),
    outgoing: map.links.filter((l) => l.from === id).map((l) => arrow(l, l.to)),
    incoming: map.links.filter((l) => l.to === id).map((l) => arrow(l, l.from)),
    fields,
    sources: [node.kicker, node.src].filter((s) => s !== undefined),
  };
}

if (import.meta.main) {
  try {
    const [dir, id, ...extra] = process.argv.slice(2);

    if (dir === undefined || id === undefined || extra.length > 0) {
      throw new QueryError("usage: bun query.ts <map folder> <node id>");
    }

    const mapFile = join(resolve(dir), MAP_FILE);
    const loaded: { readonly default?: AtlasMap } = await import(mapFile);

    if (loaded.default === undefined) {
      throw new QueryError(`${mapFile}: no default export; it exports the map's AtlasMap`);
    }

    console.log(JSON.stringify(queryNode(loaded.default, id), null, 2));
  } catch (error: unknown) {
    if (!(error instanceof QueryError)) {
      throw error;
    }

    console.error(`query: ${error.message}`);
    process.exit(1);
  }
}
