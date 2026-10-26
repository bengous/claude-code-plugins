import { inspect } from "node:util";

import type { AtlasMap, Config, Link, Node, Panel } from "../model/atlas.ts";
import { drawableOf } from "../model/drawable.ts";
import { MarkupError } from "../model/markup.ts";
import { ConfigError } from "../model/settings.ts";
import type { Settings } from "../model/settings.ts";
import type { Threads } from "../model/threads.ts";
import { firstLine, openItems, plainText, readThreads, waitsFor } from "../model/threads.ts";
import type { Tree } from "../model/tree.ts";
import { TreeError, isLeaf } from "../model/tree.ts";

// Validates a map folder's data and threads.json without a browser, for `cli.ts check`, which
// also lists the open points (openReport).
// The types (atlas.ts) already hold the shape of every field, and drawableOf (drawable.ts) refuses
// a tree no view can show, a colour outside the palette and markup a panel would not keep among
// them; this checks what they cannot,
// and fails on what would mislead a reader:
//   - a `brief` on a leaf;
//   - a `rank` that is not an integer from 0;
//   - a root's `tour` that names what is no node with children, or misses one;
//   - an id in `see`, `seams` or `traps`, on the root or on any node, that no node carries;
//   - a tag outside the Config's `tags`, and, when they say so, a link between two leaves into an
//     outside one that is not on the left and names no tag; a link with a container end names the
//     arrow between boxes, whose tags are its leaf links';
//   - an open point whose id is not unique or not kebab-case, or whose text matches one of the
//     Config's `stepWords`: an open point describes a state;
//   - a thread of threads.json under an unknown open id, or with a `who` outside the enumeration.
// Layout is not checked here: ELK and libavoid lay each view out in the browser, and nothing
// overlaps by construction. Look at the rendered page (serve.ts) for the rest.
function checkNodes(tree: Tree, errors: string[]): void {
  for (const node of tree.nodes.values()) {
    if (node.children === undefined && node.brief !== undefined) {
      errors.push(`node ${node.id}: brief is for a node with children`);
    }

    if (node.rank !== undefined && !(Number.isInteger(node.rank) && node.rank >= 0)) {
      errors.push(
        `node ${node.id}: rank ${inspect(node.rank)} is not an integer from 0; give 0 to the first band, 1 to the next, or no rank`,
      );
    }
  }

  const { tour } = tree.map.root;

  if (tour === undefined) {
    return;
  }

  for (const id of tour) {
    if (tree.nodes.get(id)?.children === undefined) {
      errors.push(`tour lists ${id}, which is no node with children`);
    }
  }

  for (const node of tree.nodes.values()) {
    if (node.children !== undefined && !tour.includes(node.id)) {
      errors.push(`tour misses ${node.id}, a node with children`);
    }
  }
}

const outsideLeafOff = (tree: Tree, id: string): boolean =>
  tree.sides.has(id) && tree.sides.get(id) !== "in" && isLeaf(tree, id);

const linkName = (l: Link): string => `link ${l.from} → ${l.to}`;

function checkLinks(tree: Tree, s: Settings, errors: string[]): void {
  for (const link of tree.map.links) {
    for (const tag of link.tags ?? []) {
      if (!s.tags.names.includes(tag)) {
        errors.push(`${linkName(link)}: tag ${tag} is not in the config's tags`);
      }
    }

    if (
      s.tags.outside === "required" &&
      isLeaf(tree, link.from) &&
      outsideLeafOff(tree, link.to) &&
      (link.tags === undefined || link.tags.length === 0)
    ) {
      errors.push(`${linkName(link)}: a link into a third-party service names its tags`);
    }
  }
}

function checkPanels(tree: Tree, errors: string[]): void {
  const panels: Array<[string, Panel]> = [
    ["root", tree.map.root],
    ...[...tree.nodes.values()].map((n): [string, Node] => [`node ${n.id}`, n]),
  ];

  for (const [where, panel] of panels) {
    for (const id of panel.see ?? []) {
      if (!tree.nodes.has(id)) {
        errors.push(`${where}: see unknown id ${id}`);
      }
    }

    for (const [field, pairs] of [
      ["seams", panel.seams],
      ["traps", panel.traps],
    ] as const) {
      for (const [id] of pairs ?? []) {
        if (!tree.nodes.has(id)) {
          errors.push(`${where}: ${field} unknown id ${id}`);
        }
      }
    }
  }
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function checkOpen(tree: Tree, s: Settings, threads: Threads, errors: string[]): void {
  const ids = new Set<string>();

  for (const item of openItems(tree)) {
    const where = `${item.kind} ${item.owner}: open point ${item.id}`;

    if (ids.has(item.id)) {
      errors.push(`${where}: duplicate open id`);
    }

    ids.add(item.id);

    if (!KEBAB.test(item.id)) {
      errors.push(`${where}: the id must be kebab-case`);
    }

    const word = s.stepWords
      .map((re) => re.exec(plainText(item.text))?.[0])
      .find((w) => w !== undefined);

    if (word !== undefined) {
      errors.push(`${where}: "${word}" names a step; an open point describes a state`);
    }
  }

  for (const id of Object.keys(threads)) {
    if (!ids.has(id)) {
      errors.push(`threads.json: thread for unknown open id ${id}`);
    }
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- threads is the content of threads.json as JSON.parse left it: readThreads below is its parser, and its errors join the map's.
export function validate(tree: Tree, s: Settings, threads: unknown): string[] {
  const errors: string[] = [];
  checkNodes(tree, errors);
  checkLinks(tree, s, errors);
  checkPanels(tree, errors);
  const read = readThreads(threads);
  errors.push(...read.errors);
  checkOpen(tree, s, read.threads, errors);

  return errors;
}

// A map folder's data as check.ts sees it: drawableOf's refusal, or what validate finds.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- threads is threads.json as JSON.parse left it, which validate hands to its parser.
export function checkMap(map: AtlasMap, config: Config, threads: unknown): string[] {
  try {
    const { tree, settings } = drawableOf(map, config);

    return validate(tree, settings, threads);
  } catch (error: unknown) {
    if (error instanceof MarkupError) {
      return [...error.faults];
    }

    if (error instanceof TreeError || error instanceof ConfigError) {
      return [error.message];
    }

    throw error;
  }
}

export function openReport(tree: Tree, threads: Threads): string {
  const items = openItems(tree);

  const rows = items.map((item) => [
    item.id,
    `${item.kind} ${item.owner}`,
    `waits: ${waitsFor(threads[item.id]) ?? "nobody"}`,
    firstLine(item.text),
  ]);

  const widths = [0, 1, 2].map((c) => Math.max(...rows.map((r) => r[c]?.length ?? 0)));

  const lines = rows.map((r) =>
    r
      .map((cell, c) => cell.padEnd(widths[c] ?? 0))
      .join("  ")
      .trimEnd(),
  );

  const count = (who: string): number =>
    items.filter((i) => waitsFor(threads[i.id]) === who).length;

  return [
    ...lines,
    `${items.length} open points: ${count("agent")} wait for agent, ${count("human")} wait for human`,
  ].join("\n");
}
