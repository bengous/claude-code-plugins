/**
 * Every copy of `tools/platform/`, which `scripts/gates/sync-platform.ts` writes and holds identical:
 * `<owner>/lib/platform` or `<owner>/src/platform`, relative to the repository's root, `<owner>` a
 * directory at the root. A copy holds the modules its owner imports from it, and what they import.
 */
export const CONSUMERS: readonly string[] = [
  "agent-hooks/lib/platform",
  "agents-bridge/lib/platform",
  "atlas/src/platform",
  "clean-comments/lib/platform",
  "context-management/lib/platform",
  "git/lib/platform",
  "git-sweep/lib/platform",
  "github-flow/lib/platform",
  "pinpoint/lib/platform",
  "secret-pane/lib/platform",
  "session-archive/lib/platform",
  "todos/lib/platform",
  "vellum/src/platform",
];
