import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "overlay", "main.ts");

/**
 * The overlay, built once per server. An IIFE, since a classic `<script>` shares the app's global
 * scope: the default ESM output has no wrapper, and its names would collide with the app's.
 * The session's directory is written into it, so a page learns where its batches go with no request.
 */
export async function buildOverlay(root: string): Promise<string> {
  const built = await Bun.build({
    entrypoints: [ENTRY],
    format: "iife",
    target: "browser",
    define: { PINPOINT_ROOT: JSON.stringify(root) },
  });

  const output = built.outputs[0];

  if (!built.success || output === undefined) {
    throw new Error(`pinpoint: building the overlay failed: ${built.logs.map(String).join("\n")}`);
  }

  return await output.text();
}
