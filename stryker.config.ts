import type { Stryker } from "@stryker-mutator/core";

type StrykerOptions = ConstructorParameters<typeof Stryker>[0];

/**
 * Read by `scripts/mutation.ts`, which mutates only the lines a change alters in the `mutate`
 * modules, each against the `.test.ts` beside it. A module joins once those tests are pure: a
 * git fixture under Stryker's parallel runs gives false kills.
 */
export default {
  mutate: ["agent-hooks/config.ts", "scripts/changelog.ts"],
  testRunner: "command",
  coverageAnalysis: "off",
  mutator: { excludedMutations: ["StringLiteral"] },
  reporters: ["clear-text"],
  clearTextReporter: { reportMutants: false, reportTests: false },
  // A missing file skips Stryker's tsconfig rewrite, which calls the
  // `ts.parseConfigFileTextToJson` TypeScript 7 no longer has.
  tsconfigFile: "stryker-skips-the-tsconfig-rewrite.json",
  // `scripts/changelog.test.ts` reads the repository's history, which a sandbox copy lacks.
  inPlace: true,
  // Bun runs TypeScript unchecked; `true` would rewrite every TypeScript file in place.
  disableTypeChecks: false,
} satisfies StrykerOptions;
