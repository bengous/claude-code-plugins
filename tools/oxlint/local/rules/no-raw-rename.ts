import { defineRule } from "@oxlint/plugins";

import { fsMemberVisitors } from "../shared/fs-member.ts";
import { isPlatformExempt } from "../shared/platform-exempt.ts";

const RENAMES = new Set(["rename", "renameSync"]);

/** Ban a rename straight from `node:fs`: `rename` of the platform helpers retries what Windows holds. */
export const noRawRenameRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `rename` and `renameSync` from `node:fs`, imported, required or loaded by `await import()`; use `rename`, `renameSync` or `writeAtomic` of the platform helpers.",
    },
    messages: {
      rawRename:
        "`{{name}}` from `{{source}}` renames without the platform helpers: use `rename`, `renameSync` or `writeAtomic` from `tools/platform/fs.ts` (the directory's own copy in a plugin).",
    },
  },
  create(context) {
    if (isPlatformExempt(context.cwd, context.filename)) return {};

    return fsMemberVisitors(context.sourceCode, RENAMES, (node, name, source) =>
      context.report({ node, messageId: "rawRename", data: { name, source } }),
    );
  },
});
