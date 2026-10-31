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

const BOTH: readonly PlatformFile[] = ["pure.ts", "node.ts"];

const PURE: readonly PlatformFile[] = ["pure.ts"];

/** Every copy of `tools/platform/`, which `scripts/sync-platform.ts` writes and holds identical. */
export const CONSUMERS: readonly Consumer[] = [
  { dir: "agent-hooks/lib/platform", files: BOTH },
  { dir: "agents-bridge/lib/platform", files: BOTH },
  { dir: "atlas/src/platform", files: BOTH },
  { dir: "clean-comments/lib/platform", files: PURE },
  { dir: "context-management/lib/platform", files: BOTH },
  { dir: "git/lib/platform", files: BOTH },
  { dir: "git-sweep/lib/platform", files: BOTH },
  { dir: "github-flow/lib/platform", files: BOTH },
  { dir: "pinpoint/lib/platform", files: BOTH },
  { dir: "secret-pane/lib/platform", files: PURE },
  { dir: "session-archive/lib/platform", files: BOTH },
  { dir: "todos/lib/platform", files: BOTH },
  { dir: "vellum/src/platform", files: BOTH },
];
