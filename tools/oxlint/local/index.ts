import { definePlugin } from "@oxlint/plugins";

import { noFrozenFactsRule } from "./rules/no-frozen-facts.ts";

/** The repository's own Oxlint rules, beside the vendored anti-slop pack. */
const localPlugin = definePlugin({
  meta: { name: "local" },
  rules: {
    "no-frozen-facts": noFrozenFactsRule,
  },
});

export default localPlugin;
