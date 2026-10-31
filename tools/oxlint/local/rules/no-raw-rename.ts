import type { ESTree } from "@oxlint/plugins";
import { defineRule } from "@oxlint/plugins";

import { importOf } from "../shared/import-binding.ts";
import { isPlatformExempt } from "../shared/platform-exempt.ts";

const FS_MODULES = new Set(["node:fs", "node:fs/promises", "fs", "fs/promises"]);

/** The modules whose `promises` export is `node:fs/promises`. */
const FS_WITH_PROMISES = new Set(["node:fs", "fs"]);

const RENAMES = new Set(["rename", "renameSync"]);

const WHOLE_MODULE = new Set(["*", "default"]);

function propertyName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) return node.property.type === "Identifier" ? node.property.name : null;

  return node.property.type === "Literal" && node.property.value !== null
    ? String(node.property.value)
    : null;
}

/** Ban a rename straight from `node:fs`: `rename` of the platform helpers retries what Windows holds. */
export const noRawRenameRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `rename` and `renameSync` from `node:fs`; use `rename`, `renameSync` or `writeAtomic` of the platform helpers.",
    },
    messages: {
      rawRename:
        "`{{name}}` from `{{source}}` renames without the platform helpers: use `rename`, `renameSync` or `writeAtomic` from `tools/platform/node.ts` (the directory's own copy in a plugin).",
    },
  },
  create(context) {
    if (isPlatformExempt(context.cwd, context.filename)) return {};
    const { sourceCode } = context;

    const report = (node: ESTree.Node, name: string, source: string): void =>
      context.report({ node, messageId: "rawRename", data: { name, source } });

    return {
      Identifier(node) {
        const binding = importOf(sourceCode, node);

        if (binding !== null && FS_MODULES.has(binding.source) && RENAMES.has(binding.imported))
          report(node, binding.imported, binding.source);
      },
      MemberExpression(node) {
        const name = propertyName(node);

        if (name === null || !RENAMES.has(name)) return;
        const { object } = node;

        if (object.type === "Identifier") {
          const binding = importOf(sourceCode, object);

          if (
            binding !== null &&
            FS_MODULES.has(binding.source) &&
            (WHOLE_MODULE.has(binding.imported) ||
              (binding.imported === "promises" && FS_WITH_PROMISES.has(binding.source)))
          )
            report(node, name, binding.source);

          return;
        }

        if (
          object.type === "MemberExpression" &&
          propertyName(object) === "promises" &&
          object.object.type === "Identifier"
        ) {
          const binding = importOf(sourceCode, object.object);

          if (
            binding !== null &&
            FS_WITH_PROMISES.has(binding.source) &&
            WHOLE_MODULE.has(binding.imported)
          )
            report(node, name, binding.source);
        }
      },
    };
  },
});
