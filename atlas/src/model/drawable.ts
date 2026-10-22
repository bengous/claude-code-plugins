import type { AtlasMap, Config } from "./atlas.ts";
import { MarkupError, mapMarkupFaults } from "./markup.ts";
import type { Settings } from "./settings.ts";
import { ConfigError, settingsOf } from "./settings.ts";
import type { Tree } from "./tree.ts";
import { treeOf } from "./tree.ts";

export type Drawable = { readonly tree: Tree; readonly settings: Settings };

/**
 * A map and its Config as the page draws them. Refuses, naming what, a map no view can show
 * (TreeError), markup its panels would not keep (MarkupError, every fault), a Config the page
 * cannot use (ConfigError, settingsOf), and a colour outside the palette (ConfigError).
 */
export function drawableOf(map: AtlasMap, config: Config): Drawable {
  const tree = treeOf(map);
  const faults = mapMarkupFaults(map);

  if (faults.length > 0) {
    throw new MarkupError(faults);
  }

  const settings = settingsOf(config);

  for (const node of tree.nodes.values()) {
    if (!Object.hasOwn(settings.palette, node.color)) {
      throw new ConfigError(`node ${node.id}: color ${node.color} is not in the palette`);
    }
  }

  return { tree, settings };
}
