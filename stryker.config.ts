import type { Stryker } from "@stryker-mutator/core";

type StrykerOptions = ConstructorParameters<typeof Stryker>[0];

/**
 * Read by `scripts/mutation.ts`, which mutates only the lines a change alters in the `mutate`
 * modules, each against the `.test.ts` beside it. A module joins once a run of it kills by assertion
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
  // For tests that read the repository's history, as `scripts/changelog.test.ts`'s do: a sandbox
  // copy has none.
  inPlace: true,
  // Bun runs TypeScript unchecked; `true` would rewrite every TypeScript file in place.
  disableTypeChecks: false,
} satisfies StrykerOptions;
