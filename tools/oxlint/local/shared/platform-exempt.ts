/** The platform helpers themselves: the source and every copy `scripts/gates/sync-platform.ts` writes. */
const PLATFORM = /^(?:tools\/platform|[^/]+\/(?:lib|src)\/platform)\//u;

/** Tests and what only they load, which spawn and rename to set a scene, never for the product. */
const TEST_SUPPORT = [
  ".test.",
  ".spec.",
  ".fixture.",
  "/fixtures/",
  "/fixtures.ts",
  "test-support.ts",
  "/e2e/",
];

const normalized = (path: string): string => path.replaceAll("\\", "/").replace(/\/+$/u, "");

/**
 * Whether the platform rules leave `filename` alone: the helpers, the tests and their support.
 * The path is read relative to `cwd`, the directory oxlint runs from, the repository's root.
 */
export function isPlatformExempt(cwd: string, filename: string): boolean {
  const root = `${normalized(cwd)}/`;
  const file = normalized(filename);
  const relative = file.startsWith(root) ? file.slice(root.length) : file;

  return PLATFORM.test(relative) || TEST_SUPPORT.some((marker) => `/${relative}`.includes(marker));
}
