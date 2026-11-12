#!/usr/bin/env bun
/**
 * Measure a Python tree: every .py file with its line count, and every import that lands on another
 * file of the tree. Imports are read from the text once strings and comments are blanked out, so an
 * import written inside a docstring or a comment is not one.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { writeAtomic } from "../../../lib/platform/fs.ts";
import { lineCount, listFiles } from "./files.ts";
import type { Graph, GraphNode, Link } from "./map.ts";

const HELP = `extract-python.ts ROOT --out graph.json [--package NAME] [--exclude GLOB]... [--no-git]

Paths in the graph are relative to ROOT. An import resolves when it names a file under ROOT, either as
written (a.b -> a/b.py or a/b/__init__.py) or after dropping the --package prefix. Everything else
(stdlib, third party) is left out: the map shows the tree's own links.

  --package   import prefix that maps to ROOT (default: ROOT's name when it holds __init__.py)
  --exclude   glob of paths to leave out; repeatable
  --no-git    walk the directory instead of asking git for tracked files`;

/** The source with every string literal and comment replaced by spaces, newlines kept. */
export function blankNoise(source: string): string {
  const out: string[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source.charAt(index);

    if (char === "#") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;

      out.push(" ".repeat(stop - index));
      index = stop;
    } else if (char === '"' || char === "'") {
      const quote = source.startsWith(char.repeat(3), index) ? char.repeat(3) : char;
      let cursor = index + quote.length;

      while (cursor < source.length) {
        const current = source.charAt(cursor);

        if (current === "\\") {
          cursor += 2;
        } else if (source.startsWith(quote, cursor)) {
          cursor += quote.length;
          break;
        } else if (quote.length === 1 && current === "\n") {
          break;
        } else {
          cursor += 1;
        }
      }

      const stop = Math.min(cursor, source.length);

      out.push(source.slice(index, stop).replaceAll(/[^\n]/gu, " "));
      index = stop;
    } else {
      out.push(char);
      index += 1;
    }
  }

  return out.join("");
}

const FROM_IMPORT =
  /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|(?:[^\n\\;]|\\\n)*)/gmu;

const PLAIN_IMPORT = /^[ \t]*import[ \t]+((?:[^\n\\;]|\\\n)*)/gmu;

/** The first word of each comma-separated item: `a as b, (c)` gives `a`, `c`. */
function names(list: string): string[] {
  return list
    .replaceAll(/[()\\]/gu, " ")
    .split(",")
    .map((item) => item.trim().split(/\s+/u)[0] ?? "")
    .filter((name) => name !== "");
}

/** One import statement: the module's dotted parts, relative level, and the names it imports. */
export type ImportStatement = {
  readonly level: number;
  readonly module: readonly string[];
  readonly names: readonly (string | null)[];
};

export function importsOf(source: string): ImportStatement[] {
  const text = blankNoise(source);
  const found: ImportStatement[] = [];

  for (const match of text.matchAll(FROM_IMPORT)) {
    const module = match[2] ?? "";

    found.push({
      level: (match[1] ?? "").length,
      module: module === "" ? [] : module.split("."),
      names: names(match[3] ?? ""),
    });
  }

  for (const match of text.matchAll(PLAIN_IMPORT)) {
    for (const name of names(match[1] ?? ""))
      found.push({ level: 0, module: name.split("."), names: [null] });
  }

  return found;
}

/** The links of a set of Python files: `files` maps each path to its source. */
export function pythonLinks(
  files: ReadonlyMap<string, string>,
  packageName: string | null,
): Link[] {
  const known = new Set(files.keys());
  const prefix = packageName === null ? [] : packageName.split(".");

  const resolveModule = (parts: readonly string[], name: string | null): string | null => {
    const prefixed = prefix.length > 0 && prefix.every((part, at) => parts[at] === part);
    const variants = prefixed ? [parts.slice(prefix.length), parts] : [parts];

    for (const variant of variants) {
      const stem = variant.join("/");
      const candidates: string[] = [];

      if (name !== null) {
        candidates.push(
          stem === "" ? `${name}.py` : `${stem}/${name}.py`,
          stem === "" ? `${name}/__init__.py` : `${stem}/${name}/__init__.py`,
        );
      }

      candidates.push(stem === "" ? "__init__.py" : `${stem}.py`);

      if (stem !== "") candidates.push(`${stem}/__init__.py`);

      const hit = candidates.find((candidate) => known.has(candidate));

      if (hit !== undefined) return hit;
    }

    return null;
  };

  const links = new Set<string>();

  for (const [path, source] of files) {
    const here = path.split("/").slice(0, -1);

    for (const statement of importsOf(source)) {
      const base = statement.level === 0 ? [] : here.slice(0, here.length - (statement.level - 1));
      const parts = [...base, ...statement.module];

      for (const name of statement.names) {
        const target = resolveModule(parts, name);

        if (target !== null && target !== path) links.add(`${path}\n${target}`);
      }
    }
  }

  return [...links].toSorted().map((key) => {
    const [from = "", to = ""] = key.split("\n");

    return [from, to] as const;
  });
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      package: { type: "string" },
      exclude: { type: "string", multiple: true },
      "no-git": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  const rootArg = positionals[0];

  if (values.help === true || rootArg === undefined || values.out === undefined) {
    console.log(HELP);
    process.exit(values.help === true ? 0 : 2);
  }

  const root = resolve(rootArg);

  const paths = await listFiles(
    root,
    values["no-git"] !== true,
    (path) => path.endsWith(".py"),
    values.exclude ?? [],
  );

  const sources = new Map(
    paths.map((path) => [path, readFileSync(join(root, path), "utf8")] as const),
  );

  const packageName =
    values.package ?? (existsSync(join(root, "__init__.py")) ? basename(root) : null);

  const nodes: GraphNode[] = paths.map((path) => ({
    path,
    size: lineCount(sources.get(path) ?? ""),
  }));

  const edges = pythonLinks(sources, packageName);
  const graph: Graph = { root: basename(root), unit: "lines", nodes, edges };

  await writeAtomic(values.out, JSON.stringify(graph), { mkdir: true });
  console.log(
    `${nodes.length} files, ${nodes.reduce((sum, node) => sum + node.size, 0)} lines, ${edges.length} links -> ${values.out}`,
  );
}

if (import.meta.main) await main();
