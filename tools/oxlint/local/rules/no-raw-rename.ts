import type { ESTree, SourceCode } from "@oxlint/plugins";
import { defineRule } from "@oxlint/plugins";

import { constValueOf, importOf, isGlobalNamed, unwrapTs } from "../shared/import-binding.ts";
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

function literalOf(node: ESTree.Node): string | null {
  return node.type === "Literal" && node.value !== null ? String(node.value) : null;
}

/** The module a `require("<module>")` or an `await import("<module>")` loads; `null` for any other node. */
function loadedModule(sourceCode: SourceCode, node: ESTree.Node): string | null {
  const value = unwrapTs(node);

  if (value.type === "AwaitExpression") {
    const awaited = unwrapTs(value.argument);

    return awaited.type === "ImportExpression" ? literalOf(awaited.source) : null;
  }

  if (
    value.type !== "CallExpression" ||
    value.callee.type !== "Identifier" ||
    !isGlobalNamed(sourceCode, value.callee, "require")
  )
    return null;
  const [specifier] = value.arguments;

  return specifier === undefined ? null : literalOf(specifier);
}

/** The fs module `node` loads through `require` or `await import()`, or the `const` holding such a load. */
function fsModuleOf(sourceCode: SourceCode, node: ESTree.Node): string | null {
  const value = unwrapTs(node);
  const held = value.type === "Identifier" ? constValueOf(sourceCode, value) : value;
  const source = held === null ? null : loadedModule(sourceCode, held);

  return source !== null && FS_MODULES.has(source) ? source : null;
}

function keyName(property: ESTree.ObjectPattern["properties"][number]): string | null {
  if (property.type !== "Property" || property.computed) return null;

  return property.key.type === "Identifier" ? property.key.name : literalOf(property.key);
}

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
        const loaded = fsModuleOf(sourceCode, object);

        if (loaded !== null) {
          report(node, name, loaded);

          return;
        }

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

        if (object.type !== "MemberExpression" || propertyName(object) !== "promises") return;
        const loadedParent = fsModuleOf(sourceCode, object.object);

        if (loadedParent !== null) {
          if (FS_WITH_PROMISES.has(loadedParent)) report(node, name, loadedParent);

          return;
        }

        if (object.object.type === "Identifier") {
          const binding = importOf(sourceCode, object.object);

          if (
            binding !== null &&
            FS_WITH_PROMISES.has(binding.source) &&
            WHOLE_MODULE.has(binding.imported)
          )
            report(node, name, binding.source);
        }
      },
      VariableDeclarator(node) {
        if (node.id.type !== "ObjectPattern" || node.init === null) return;
        const source = fsModuleOf(sourceCode, node.init);

        if (source === null) return;

        for (const property of node.id.properties) {
          const key = keyName(property);

          if (key !== null && RENAMES.has(key)) report(property, key, source);
        }
      },
    };
  },
});
