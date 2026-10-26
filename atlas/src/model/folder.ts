import { join, resolve } from "node:path";

import type { AtlasMap, Config } from "./atlas.ts";
import { mapCitations } from "./citations.ts";
import { drawableOf } from "./drawable.ts";
import type { Tree } from "./tree.ts";

// A map folder holds a map's data and nothing of the engine: map.ts, whose default export is the
// AtlasMap, atlas.config.ts, whose default export is its Config, and threads.json. The data imports
// types only, so the folder needs no package.json. serve.ts bundles the first two into the page;
// cli.ts imports them here.
//   bun atlas/src/model/folder.ts <map folder>   prints what serve.ts knows of the map, FolderLine,
//                                      as JSON on its last line, after FOLDER_LINE, or exits 1
//                                      with the reason when the engine cannot draw the map
export const MAP_FILE = "map.ts";

export const CONFIG_FILE = "atlas.config.ts";

export const THREADS_FILE = "threads.json";

export type Folder = { readonly map: AtlasMap; readonly config: Config };

export async function loadFolder(dir: string): Promise<Folder> {
  const mapFile = join(dir, MAP_FILE);
  const configFile = join(dir, CONFIG_FILE);
  // Typed by the files themselves: each declares its default export `satisfies` the type of atlas.ts.
  const map: { readonly default?: AtlasMap } = await import(mapFile);
  const config: { readonly default?: Config } = await import(configFile);

  if (map.default === undefined) {
    throw new Error(`${mapFile}: no default export; it exports the map's AtlasMap`);
  }

  if (config.default === undefined) {
    throw new Error(`${configFile}: no default export; it exports the map's Config`);
  }

  return { map: map.default, config: config.default };
}

// What the page names each node by, by id: the map's own text, the only ids a selection the page
// posts may name.
export function labelsOf(tree: Tree): Record<string, string> {
  return Object.fromEntries(
    [...tree.nodes.values()].map((node): [string, string] => [node.id, node.label]),
  );
}

/** What serve.ts knows of the map, which it never imports: the line this module prints. */
export type FolderLine = {
  /** labelsOf: the ids a selection may name. */
  readonly labels: Readonly<Record<string, string>>;
  /**
   * The Config's sources root, resolved from the map folder, and every path a citation or a `src`
   * of the map names, the only ones the page may ask the lines of; null without `sources`.
   */
  readonly sources: { readonly root: string; readonly paths: readonly string[] } | null;
};

export function folderLineOf(map: AtlasMap, config: Config, dir: string): FolderLine {
  const { tree } = drawableOf(map, config);

  if (config.sources === undefined) {
    return { labels: labelsOf(tree), sources: null };
  }

  const named = [
    ...mapCitations(map).map(({ citation }) => citation.path),
    ...[map.root, ...tree.nodes.values()].flatMap(({ src }) => (src === undefined ? [] : [src])),
  ];

  return {
    labels: labelsOf(tree),
    sources: { root: resolve(dir, config.sources.root), paths: [...new Set(named)].toSorted() },
  };
}

// The map's code shares this process's stdout and may print to it: the line is marked.
export const FOLDER_LINE = "atlas folder: ";

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- the block below IS the boundary parser of the line this module prints, which serve.ts reads from another process as JSON.parse leaves it: there is no earlier place to narrow it. */
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTexts = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function sourcesIn(value: unknown): FolderLine["sources"] | undefined {
  if (value === null) {
    return null;
  }

  if (!isRecord(value) || typeof value["root"] !== "string" || !isTexts(value["paths"])) {
    return undefined;
  }

  return { root: value["root"], paths: [...value["paths"]] };
}

/** The last line of `stdout` marked FOLDER_LINE, read; anything else reads as no map, null. */
export function readFolderLine(stdout: string): FolderLine | null {
  const line = stdout.split("\n").findLast((printed) => printed.startsWith(FOLDER_LINE));

  if (line === undefined) {
    return null;
  }

  let value: unknown;

  try {
    value = JSON.parse(line.slice(FOLDER_LINE.length));
  } catch {
    return null;
  }

  if (!isRecord(value) || !isRecord(value["labels"])) {
    return null;
  }

  const labels = Object.entries(value["labels"]);
  const sources = sourcesIn(value["sources"]);

  return sources === undefined || !labels.every(([, label]) => typeof label === "string")
    ? null
    : { labels: Object.fromEntries(labels.map(([id, label]) => [id, String(label)])), sources };
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type */

// serve.ts runs this for each build in a fresh process: an imported module keeps its first
// evaluation for the life of the process, and the data changes on every save. It prints
// folderLineOf as JSON after FOLDER_LINE.
if (import.meta.main) {
  const [dir, ...extra] = process.argv.slice(2);

  if (dir === undefined || extra.length > 0) {
    console.error("usage: bun folder.ts <map folder>");
    process.exit(1);
  }

  try {
    const folder = resolve(dir);
    const { map, config } = await loadFolder(folder);
    console.log(`${FOLDER_LINE}${JSON.stringify(folderLineOf(map, config, folder))}`);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
