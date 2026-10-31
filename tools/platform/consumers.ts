/** The source files a consumer may copy; a directory with mods alone copies `pure.ts` only. */
export type PlatformFile = "pure.ts" | "node.ts";

/**
 * A directory holding a copy of `tools/platform/`: `<owner>/lib/platform` or
 * `<owner>/src/platform`, relative to the repository's root, `<owner>` a directory at the root.
 */
export type Consumer = {
  readonly dir: string;
  readonly files: readonly PlatformFile[];
};

/** Every copy of `tools/platform/`, which `scripts/sync-platform.ts` writes and holds identical. */
export const CONSUMERS: readonly Consumer[] = [];
