#!/usr/bin/env bun
/**
 * Measure a JavaScript or TypeScript tree: every source file with its line count, and every import,
 * re-export, require() or import() that lands on another file of the tree. Specifiers are resolved
 * like a bundler does: relative paths, then aliases, then the extension and index candidates. Bare
 * package names are left out.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { posix } from "node:path";
import { parseArgs } from "node:util";

import { writeAtomic } from "../../../lib/platform/fs.ts";
import { lineCount, listFiles } from "./files.ts";
import type { Graph, GraphNode, Link } from "./map.ts";

const HELP = `extract-js.ts ROOT --out graph.json [--alias PREFIX=PATH]... [--exclude GLOB]... [--no-git]

  --alias     an import prefix mapped to a path relative to ROOT, e.g. '@/=src/' when ROOT is the
              folder holding src/; repeatable. The simple
              "prefix/*" entries of the "paths" of a tsconfig.json at ROOT are read as aliases too.
  --exclude   glob of paths to leave out; repeatable
  --no-git    walk the directory instead of asking git for tracked files`;

const EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".svelte",
];

const TS_FOR_JS: ReadonlyMap<string, readonly string[]> = new Map([
  [".js", [".ts", ".tsx"]],
  [".jsx", [".tsx"]],
  [".mjs", [".mts"]],
  [".cjs", [".cts"]],
]);

const SPECIFIER =
  /(?:\bimport\s+(?:type\s+)?(?:[\w*${}\s,]+?\s+from\s+)?|\bexport\s+(?:type\s+)?[\w*{}\s,]+?\s+from\s+|\brequire\s*\(\s*|\bimport\s*\(\s*)["']([^"'\n]+)["']/gu;

export type Alias = readonly [prefix: string, target: string];

const isSource = (path: string): boolean =>
  EXTENSIONS.includes(extname(path)) && !path.endsWith(".d.ts");

/**
 * The source with its comments blanked out, strings kept, newlines kept. With `blankTemplates`,
 * the content of template literals is blanked too: code written there is text, not an import.
 */
export function blankComments(source: string, blankTemplates: boolean): string {
  const out: string[] = [];
  let index = 0;

  const blank = (stop: number): void => {
    out.push(source.slice(index, stop).replaceAll(/[^\n]/gu, " "));
    index = stop;
  };

  while (index < source.length) {
    const char = source.charAt(index);

    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);

      blank(end === -1 ? source.length : end);
    } else if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);

      blank(end === -1 ? source.length : end + 2);
    } else if (char === '"' || char === "'" || char === "`") {
      let cursor = index + 1;

      while (cursor < source.length && source.charAt(cursor) !== char) {
        if (char !== "`" && source.charAt(cursor) === "\n") break;
        cursor += source.charAt(cursor) === "\\" ? 2 : 1;
      }

      const stop = Math.min(cursor + 1, source.length);

      if (char === "`" && blankTemplates) {
        out.push("`");
        index += 1;
        blank(Math.max(index, stop - 1));
      }

      out.push(source.slice(index, stop));
      index = stop;
    } else {
      out.push(char);
      index += 1;
    }
  }

  return out.join("");
}

/** Every module specifier a source names, in order; comments and template literals are not code. */
export function specifiersOf(source: string): string[] {
  return [...blankComments(source, true).matchAll(SPECIFIER)].map((match) => match[1] ?? "");
}

/**
 * The simple `prefix/*` entries of a tsconfig's `compilerOptions.paths`, as aliases; null when the
 * text is not JSON once its comments and trailing commas are removed.
 */
export function tsconfigAliases(text: string): Alias[] | null {
  const json = blankComments(text, false).replaceAll(/,(\s*[}\]])/gu, "$1");

  let parsed: {
    readonly compilerOptions?: {
      readonly baseUrl?: string;
      readonly paths?: Readonly<Record<string, readonly string[]>>;
    };
  };

  try {
    // SAFETY: a tsconfig; only compilerOptions.baseUrl and compilerOptions.paths are read, each
    // through optional chaining, and an entry that is not `prefix/*` is skipped.
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    return null;
  }

  const options = parsed.compilerOptions ?? {};
  const base = options.baseUrl ?? ".";
  const aliases: Alias[] = [];

  for (const [key, targets] of Object.entries(options.paths ?? {})) {
    const first = targets[0];

    if (key.endsWith("/*") && first?.endsWith("/*") === true) {
      const folder = posix.normalize(posix.join(base, first.slice(0, -1))).replace(/\/$/u, "");

      aliases.push([key.slice(0, -1), `${folder}/`]);
    }
  }

  return aliases;
}

function candidates(target: string): string[] {
  const normal = posix.normalize(target);
  const extension = posix.extname(normal);
  const stem = normal.slice(0, normal.length - extension.length);

  return [
    normal,
    ...(TS_FOR_JS.get(extension) ?? []).map((alternative) => stem + alternative),
    ...EXTENSIONS.map((ext) => normal + ext),
    ...EXTENSIONS.map((ext) => `${normal}/index${ext}`),
  ];
}

export type JsLinks = { readonly links: Link[]; readonly missed: number };

/** The links of a set of JS/TS files: `files` maps each path to its source. */
export function jsLinks(files: ReadonlyMap<string, string>, aliases: readonly Alias[]): JsLinks {
  const known = new Set(files.keys());

  const ordered = [...aliases]
    .map(([prefix, target]): Alias => [
      prefix,
      target === "." || target === "./" ? "" : target.replace(/^\.\//u, ""),
    ])
    .toSorted((a, b) => b[0].length - a[0].length);

  const links = new Set<string>();
  let missed = 0;

  for (const [path, source] of files) {
    for (const specifier of specifiersOf(source)) {
      const bases = specifier.startsWith(".")
        ? [posix.join(posix.dirname(path), specifier)]
        : ordered.flatMap(([prefix, target]) =>
            specifier.startsWith(prefix) ? [target + specifier.slice(prefix.length)] : [],
          );

      const target = bases
        .flatMap((base) => candidates(base))
        .find((candidate) => known.has(candidate));

      if (target !== undefined && target !== path) links.add(`${path}\n${target}`);
      else if (target === undefined && bases.length > 0) missed += 1;
    }
  }

  return {
    missed,
    links: [...links].toSorted().map((key) => {
      const [from = "", to = ""] = key.split("\n");

      return [from, to] as const;
    }),
  };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      alias: { type: "string", multiple: true },
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

  const paths = await listFiles(root, values["no-git"] !== true, isSource, values.exclude ?? []);

  const sources = new Map(
    paths.map((path) => [path, readFileSync(join(root, path), "utf8")] as const),
  );

  const tsconfig = join(root, "tsconfig.json");
  const fromTsconfig = existsSync(tsconfig) ? tsconfigAliases(readFileSync(tsconfig, "utf8")) : [];

  if (fromTsconfig === null) {
    console.log(
      `${tsconfig} could not be read as JSON: its "paths" are ignored, pass --alias instead`,
    );
  }

  const aliases: Alias[] = [
    ...(values.alias ?? []).map((entry): Alias => {
      const [prefix = "", target = ""] = entry.split("=", 2);

      return [prefix, target];
    }),
    ...(fromTsconfig ?? []),
  ];

  const nodes: GraphNode[] = paths.map((path) => ({
    path,
    size: lineCount(sources.get(path) ?? ""),
  }));

  const { links, missed } = jsLinks(sources, aliases);
  const graph: Graph = { root: basename(root), unit: "lines", nodes, edges: links };

  await writeAtomic(values.out, JSON.stringify(graph), { mkdir: true });
  console.log(
    `${nodes.length} files, ${nodes.reduce((sum, node) => sum + node.size, 0)} lines, ${links.length} links -> ${values.out}`,
  );

  if (missed > 0)
    console.log(
      `${missed} relative or aliased import(s) found no file (assets, generated code, or a wrong --alias)`,
    );
}

if (import.meta.main) await main();
