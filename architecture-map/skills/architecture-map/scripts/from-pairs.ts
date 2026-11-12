#!/usr/bin/env bun
/**
 * Turn any tool's dependency output into graph.json, for a language without its own extractor.
 * Accepts a text file with one `from<TAB>to` (or `from to`, or `from -> to`) per line, a JSON object
 * `{"from": ["to", ...]}` (madge --json), or a JSON list of `[from, to]` pairs.
 */

import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { writeAtomic } from "../../../lib/platform/fs.ts";
import { lineCount } from "./files.ts";
import type { Graph, GraphNode, Link } from "./map.ts";

const HELP = `from-pairs.ts PAIRS --out graph.json [--root DIR] [--unit NAME]

  --root   where the paths live, to measure each file (default: the current directory)
  --unit   what a node's size counts (default: lines)

A node's size is its line count when the file exists under --root, else 0. A line with a single
name declares a node with no link.`;

/** The pairs of a pairs file, a single name standing for a node with no link. */
export function readPairs(text: string): Link[] {
  const trimmed = text.trimStart();

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    // SAFETY: the documented inputs are a madge object of string lists or a list of string pairs;
    // a value of another shape makes the paths below "undefined" or a wrong type, never a crash.
    const data = JSON.parse(text) as Readonly<Record<string, readonly string[]>> | readonly Link[];

    if (Array.isArray(data)) return data.map(([from, to]) => [String(from), String(to)] as const);

    return Object.entries(data).flatMap(([from, targets]) =>
      targets.map((to) => [from, to] as const),
    );
  }

  const pairs: Link[] = [];

  for (const line of text.split("\n")) {
    const parts = line
      .trim()
      .split(/\s*->\s*|\s+/u)
      .filter((part) => part !== "");

    if (parts.length === 0 || line.trimStart().startsWith("#")) continue;

    const [from = "", to = from] = parts;

    pairs.push([from, to]);
  }

  return pairs;
}

export type PairsGraph = { readonly graph: Graph; readonly absent: number };

export function pairsGraph(
  pairs: readonly Link[],
  measure: (path: string) => number | null,
  rootName: string,
  unit: string,
): PairsGraph {
  const normal = pairs.map(
    ([from, to]) => [from.replaceAll("\\", "/"), to.replaceAll("\\", "/")] as const,
  );

  const names = [...new Set(normal.flat())].toSorted();
  let absent = 0;

  const nodes: GraphNode[] = names.map((path) => {
    const size = measure(path);

    if (size === null) absent += 1;

    return { path, size: size ?? 0 };
  });

  const seen = new Set<string>();
  const edges: Link[] = [];

  for (const [from, to] of normal) {
    const key = `${from}\n${to}`;

    if (from === to || seen.has(key)) continue;
    seen.add(key);
    edges.push([from, to]);
  }

  const sorted = edges.toSorted((a, b) =>
    `${a[0]}
${a[1]}` <
    `${b[0]}
${b[1]}`
      ? -1
      : 1,
  );

  return { absent, graph: { root: rootName, unit, nodes, edges: sorted } };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      root: { type: "string" },
      unit: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  const input = positionals[0];

  if (values.help === true || input === undefined || values.out === undefined) {
    console.log(HELP);
    process.exit(values.help === true ? 0 : 2);
  }

  const root = resolve(values.root ?? ".");

  const measure = (path: string): number | null => {
    try {
      return lineCount(readFileSync(join(root, path), "utf8"));
    } catch {
      return null;
    }
  };

  const { graph, absent } = pairsGraph(
    readPairs(readFileSync(input, "utf8")),
    measure,
    basename(root),
    values.unit ?? "lines",
  );

  await writeAtomic(values.out, JSON.stringify(graph), { mkdir: true });
  console.log(`${graph.nodes.length} nodes, ${graph.edges.length} links -> ${values.out}`);

  if (absent > 0) {
    console.log(
      `${absent} node(s) are not files under ${root}: their size is 0, so they draw at the minimum width`,
    );
  }
}

if (import.meta.main) await main();
