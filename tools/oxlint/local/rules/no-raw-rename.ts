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

/**
 * An object whose `rename` and `renameSync` are fs's: the module named `source`, whole, or its
 * `promises`; `hasPromises` while a `.promises` read off it is `node:fs/promises`.
 */
type FsObject = { readonly source: string; readonly hasPromises: boolean };

/** How many `const` bindings `fsObjectOf` follows, so that `const a = a;` ends. */
const CONST_HOPS = 8;

function wholeModule(source: string): FsObject {
  return { source, hasPromises: FS_WITH_PROMISES.has(source) };
}

/**
 * The fs object `node` reads: an fs module loaded by `require` or `await import()`, or imported
 * whole; a `promises` read off one, or imported by name; a `const` holding any of them.
 */
function fsObjectOf(sourceCode: SourceCode, node: ESTree.Node, hops = CONST_HOPS): FsObject | null {
  const value = unwrapTs(node);
  const loaded = loadedModule(sourceCode, value);

  if (loaded !== null) return FS_MODULES.has(loaded) ? wholeModule(loaded) : null;

  if (value.type === "MemberExpression") {
    if (propertyName(value) !== "promises") return null;
    const parent = fsObjectOf(sourceCode, value.object, hops);

    return parent?.hasPromises === true ? { source: parent.source, hasPromises: false } : null;
  }

  if (value.type !== "Identifier") return null;
  const binding = importOf(sourceCode, value);

  if (binding !== null) {
    if (!FS_MODULES.has(binding.source)) return null;

    if (WHOLE_MODULE.has(binding.imported)) return wholeModule(binding.source);

    return binding.imported === "promises" && FS_WITH_PROMISES.has(binding.source)
      ? { source: binding.source, hasPromises: false }
      : null;
  }

  const held = hops > 0 ? constValueOf(sourceCode, value) : null;

  return held === null ? null : fsObjectOf(sourceCode, held, hops - 1);
}

function keyName(property: ESTree.ObjectPattern["properties"][number]): string | null {
  if (property.type !== "Property" || property.computed) return null;

  return property.key.type === "Identifier" ? property.key.name : literalOf(property.key);
}

/** The pattern a destructured property binds, past its default; `null` when it binds a name. */
function nestedPattern(
  property: ESTree.ObjectPattern["properties"][number],
): ESTree.ObjectPattern | null {
  if (property.type !== "Property") return null;
  const target = property.value.type === "AssignmentPattern" ? property.value.left : property.value;

  return target.type === "ObjectPattern" ? target : null;
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

    const reportPattern = (pattern: ESTree.ObjectPattern, fs: FsObject): void => {
      for (const property of pattern.properties) {
        const key = keyName(property);

        if (key !== null && RENAMES.has(key)) report(property, key, fs.source);
        const nested = key === "promises" && fs.hasPromises ? nestedPattern(property) : null;

        if (nested !== null) reportPattern(nested, { source: fs.source, hasPromises: false });
      }
    };

    return {
      Identifier(node) {
        const binding = importOf(sourceCode, node);

        if (binding !== null && FS_MODULES.has(binding.source) && RENAMES.has(binding.imported))
          report(node, binding.imported, binding.source);
      },
      MemberExpression(node) {
        const name = propertyName(node);

        if (name === null || !RENAMES.has(name)) return;
        const fs = fsObjectOf(sourceCode, node.object);

        if (fs !== null) report(node, name, fs.source);
      },
      VariableDeclarator(node) {
        if (node.id.type !== "ObjectPattern" || node.init === null) return;
        const fs = fsObjectOf(sourceCode, node.init);

        if (fs !== null) reportPattern(node.id, fs);
      },
    };
  },
});
