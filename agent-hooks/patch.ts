const APPLY_PATCH_PREFIXES = [
  "*** Add File: ",
  "*** Update File: ",
  "*** Delete File: ",
  "*** Move to: ",
];

/** The paths a Codex `apply_patch` command touches, once each, in the order of their headers. */
export function extractApplyPatchPaths(patch: string): string[] {
  const paths = new Set<string>();

  for (const line of patch.split(/\r?\n/u)) {
    for (const prefix of APPLY_PATCH_PREFIXES) {
      if (line.startsWith(prefix)) {
        paths.add(line.slice(prefix.length).trim());
      }
    }
  }

  return [...paths];
}
