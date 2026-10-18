import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { OverlaySession } from "../shared/wire.ts";

const PLUGIN_ROOT = join(import.meta.dir, "..");

async function bundle(
  entry: string,
  options: Pick<Bun.BuildConfig, "format" | "target" | "define">,
): Promise<string> {
  const built = await Bun.build({ entrypoints: [join(PLUGIN_ROOT, entry)], ...options });
  const output = built.outputs[0];

  if (!built.success || output === undefined) {
    throw new Error(`pinpoint: building ${entry} failed: ${built.logs.map(String).join("\n")}`);
  }

  return await output.text();
}

/**
 * The overlay, built once per server. An IIFE, since a classic `<script>` shares the app's global
 * scope: the default ESM output has no wrapper, and its names would collide with the app's. A
 * classic script also loads cross-origin without CORS, where a module script would need it.
 * `session` is written into it, so a page learns where its batches go with no request.
 */
export function buildOverlay(session: OverlaySession): Promise<string> {
  return bundle("overlay/main.ts", {
    format: "iife",
    target: "browser",
    define: { PINPOINT_SESSION: JSON.stringify(session) },
  });
}

/**
 * The Vite plugin, bundled to `<dir>/vite.mjs` at each start: the path an app's `vite.config.ts`
 * imports stays the same across updates of pinpoint, and its code follows the running version.
 */
export async function writeViteModule(dir: string): Promise<string> {
  const code = await bundle("vite/pinpoint.ts", { format: "esm", target: "node" });
  const file = join(dir, "vite.mjs");
  const current = await readFile(file, "utf8").catch(() => null);

  if (current !== code) {
    await mkdir(dir, { recursive: true });
    await writeFile(file, code);
  }

  return file;
}
