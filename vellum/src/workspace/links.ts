import type { FinalDir, WipDir } from "./paths.ts";

/** Rewrites every exact occurrence of the working directory's path to the final one. */
export function rewriteLinks(text: string, from: WipDir, to: FinalDir): string {
  return text.replaceAll(from, to);
}
