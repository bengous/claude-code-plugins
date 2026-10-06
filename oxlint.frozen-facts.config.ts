import { defineConfig } from "oxlint";

import repoConfig from "./oxlint.config.ts";

// Runs `local/no-frozen-facts` alone, which oxlint.config.ts keeps off until
// the comments it reports are rewritten: `bun x oxlint -c oxlint.frozen-facts.config.ts`.
// A config of its own, since oxlint's `-D` does not reach a JS plugin's rule;
// at the root, since oxlint resolves `ignorePatterns` in the config's directory.
export default defineConfig({
  ignorePatterns: repoConfig.ignorePatterns ?? [],
  jsPlugins: [{ name: "local", specifier: "./tools/oxlint/local/index.ts" }],
  categories: { correctness: "off" },
  rules: { "local/no-frozen-facts": "error" },
});
