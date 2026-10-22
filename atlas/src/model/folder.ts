import { join, resolve } from "node:path";

import type { AtlasMap, Config } from "./atlas.ts";
import { drawableOf } from "./drawable.ts";
import type { Tree } from "./tree.ts";

// A map folder holds a map's data and nothing of the engine: map.ts, whose default export is the
// AtlasMap, atlas.config.ts, whose default export is its Config, and threads.json. The data imports
// types only, so the folder needs no package.json. serve.ts bundles the first two into the page;
// cli.ts imports them here.
//   bun atlas/src/model/folder.ts <map folder>   prints the map's labels by id on its last line, after
//                                      LABELS_LINE, or exits 1 with the reason when the engine
//                                      cannot draw the map
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

// The map's code shares this process's stdout and may print to it: the labels' line is marked.
export const LABELS_LINE = "atlas labels: ";

// serve.ts runs this for each build in a fresh process: an imported module keeps its first
// evaluation for the life of the process, and the data changes on every save. It prints the map's
// labels, labelsOf, as JSON after LABELS_LINE.
if (import.meta.main) {
  const [dir, ...extra] = process.argv.slice(2);

  if (dir === undefined || extra.length > 0) {
    console.error("usage: bun folder.ts <map folder>");
    process.exit(1);
  }

  try {
    const { map, config } = await loadFolder(resolve(dir));
    console.log(`${LABELS_LINE}${JSON.stringify(labelsOf(drawableOf(map, config).tree))}`);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
