/**
 * The paths vellum's browser suite covers: a change that touches one runs the suite in CI
 * (`reachesE2e` in `affected.ts`, read by `ci.yml`'s `scope` job).
 */

// Decided in #168, and owned here alone: what the browser suite loads. A new
// directory under `vellum/` is inside until it is listed as left out.
const E2E_PATHS = ["vellum/**", "docs/plugin-testing.md", "mise.toml", ".github/workflows/ci.yml"];

const NOT_E2E_PATHS = [
  "vellum/src/runtime/hooks/**",
  "vellum/src/steps/*/hooks.ts",
  "vellum/src/review/hooks.ts",
  "vellum/scripts/**",
  "vellum/hooks/**",
  "vellum/skills/**",
  "vellum/agents/**",
  "vellum/types/**",
  "vellum/.claude/**",
  "vellum/.claude-plugin/plugin.json",
  "vellum/*.md",
  "**/*.spec.ts",
  "**/*.test.ts",
];

const included = E2E_PATHS.map((pattern) => new Bun.Glob(pattern));

const excluded = NOT_E2E_PATHS.map((pattern) => new Bun.Glob(pattern));

export function isE2ePath(path: string): boolean {
  return included.some((glob) => glob.match(path)) && !excluded.some((glob) => glob.match(path));
}
