import { definePlugin } from "@oxlint/plugins";

import { noFrozenFactsRule } from "./rules/no-frozen-facts.ts";
import { noRawGitSpawnRule } from "./rules/no-raw-git-spawn.ts";
import { noRawRenameRule } from "./rules/no-raw-rename.ts";

/** The repository's own Oxlint rules, beside the vendored anti-slop pack. */
const localPlugin = definePlugin({
  meta: { name: "local" },
  rules: {
    "no-frozen-facts": noFrozenFactsRule,
    "no-raw-git-spawn": noRawGitSpawnRule,
    "no-raw-rename": noRawRenameRule,
  },
});

export default localPlugin;
