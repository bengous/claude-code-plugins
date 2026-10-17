import type { Stryker } from "@stryker-mutator/core";

type StrykerOptions = ConstructorParameters<typeof Stryker>[0];

/**
 * Read by `scripts/mutation.ts`, which mutates each `mutate` module a change reaches, through its
 * lines or its `.test.ts`, whole and against that `.test.ts` alone, and fails on a survivor on a
 * changed line or one the base's tests killed. A module joins once a run of it kills by assertion
 * alone: a git fixture under Stryker's parallel runs can kill a mutant by timing out. Issue #323
 * splits the pure tests of `scripts/changelog.ts` and `scripts/land.ts` from their fixtures.
 */
export default {
  mutate: ["agent-hooks/config.ts"],
  testRunner: "command",
  coverageAnalysis: "off",
  mutator: { excludedMutations: ["StringLiteral"] },
  reporters: ["clear-text"],
  clearTextReporter: { reportMutants: false, reportTests: false },
  // A missing file skips Stryker's tsconfig rewrite, which calls `ts.parseConfigFileTextToJson`,
  // an API the installed TypeScript lacks.
  tsconfigFile: "stryker-skips-the-tsconfig-rewrite.json",
  // The other checkouts of this repository live there; Stryker's sandbox copy needs none of them.
  ignorePatterns: ["/.claude/worktrees"],
} satisfies StrykerOptions;
