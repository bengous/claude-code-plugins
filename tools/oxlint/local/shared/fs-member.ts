import type { ESTree, SourceCode, Visitor } from "@oxlint/plugins";

import {
  WHOLE_MODULE,
  constValueOf,
  destructuredOf,
  importOf,
  keyName,
  loadedModule,
  propertyName,
  unwrapTs,
} from "./import-binding.ts";

const FS_MODULES = new Set(["node:fs", "node:fs/promises", "fs", "fs/promises"]);

/** The modules whose `promises` export is `node:fs/promises`. */
const FS_WITH_PROMISES = new Set(["node:fs", "fs"]);

/**
 * An object whose members are fs's: the module named `source`, whole, or its `promises`;
 * `hasPromises` while a `.promises` read off it is `node:fs/promises`.
 */
type FsObject = { readonly source: string; readonly hasPromises: boolean };

/** How many `const` bindings `fsObjectOf` follows, so that `const a = a;` ends. */
const CONST_HOPS = 8;

function wholeModule(source: string): FsObject {
  return { source, hasPromises: FS_WITH_PROMISES.has(source) };
}

/** The `promises` of `parent`, when it holds one. */
function promisesOf(parent: FsObject | null): FsObject | null {
  return parent?.hasPromises === true ? { source: parent.source, hasPromises: false } : null;
}

/**
 * The fs object `node` reads: an fs module loaded by `require` or `await import()`, or imported
 * whole; a `promises` read off one, destructured from one, or imported by name; a `const`
 * holding any of them.
 */
function fsObjectOf(sourceCode: SourceCode, node: ESTree.Node, hops = CONST_HOPS): FsObject | null {
  const value = unwrapTs(node);
  const loaded = loadedModule(sourceCode, value);

  if (loaded !== null) return FS_MODULES.has(loaded) ? wholeModule(loaded) : null;

  if (value.type === "MemberExpression")
    return propertyName(value) === "promises"
      ? promisesOf(fsObjectOf(sourceCode, value.object, hops))
      : null;

  if (value.type !== "Identifier") return null;
  const binding = importOf(sourceCode, value);

  if (binding !== null) {
    if (!FS_MODULES.has(binding.source)) return null;

    if (WHOLE_MODULE.has(binding.imported)) return wholeModule(binding.source);

    return binding.imported === "promises" ? promisesOf(wholeModule(binding.source)) : null;
  }

  if (hops === 0) return null;
  const held = constValueOf(sourceCode, value);

  if (held !== null) return fsObjectOf(sourceCode, held, hops - 1);
  const part = destructuredOf(sourceCode, value);

  if (part === null) return null;
  const parent = fsObjectOf(sourceCode, part.init, hops - 1);

  if (part.key === "default") return parent;

  return part.key === "promises" ? promisesOf(parent) : null;
}

/** The pattern a destructured property binds, past its default; `null` when it binds a name. */
function nestedPattern(
  property: ESTree.ObjectPattern["properties"][number],
): ESTree.ObjectPattern | null {
  if (property.type !== "Property") return null;
  const target = property.value.type === "AssignmentPattern" ? property.value.left : property.value;

  return target.type === "ObjectPattern" ? target : null;
}

/** Where an fs member was taken: the node, the member's name, the module it comes from. */
export type FsMemberReport = (node: ESTree.Node, name: string, source: string) => void;

/**
 * The visitors that call `report` once for each member of `names` taken from `node:fs` or
 * `node:fs/promises`: imported by name, an alias included; read off the module imported whole,
 * required or loaded by `await import()`, or off its `promises`; destructured from any of these.
 * A `typeof` in a type names the member's type, not a use of it, and is left alone.
 */
export function fsMemberVisitors(
  sourceCode: SourceCode,
  names: ReadonlySet<string>,
  report: FsMemberReport,
): Visitor {
  const reportPattern = (pattern: ESTree.ObjectPattern, fs: FsObject): void => {
    for (const property of pattern.properties) {
      const key = keyName(property);

      if (key !== null && names.has(key)) report(property, key, fs.source);
      const nested = key === "promises" ? nestedPattern(property) : null;
      const promises = nested === null ? null : promisesOf(fs);

      if (nested !== null && promises !== null) reportPattern(nested, promises);
    }
  };

  return {
    Identifier(node) {
      if (node.parent.type === "TSTypeQuery") return;
      const binding = importOf(sourceCode, node);

      if (binding !== null && FS_MODULES.has(binding.source) && names.has(binding.imported))
        report(node, binding.imported, binding.source);
    },
    MemberExpression(node) {
      const name = propertyName(node);

      if (name === null || !names.has(name)) return;
      const fs = fsObjectOf(sourceCode, node.object);

      if (fs !== null) report(node, name, fs.source);
    },
    VariableDeclarator(node) {
      if (node.id.type !== "ObjectPattern" || node.init === null) return;
      const fs = fsObjectOf(sourceCode, node.init);

      if (fs !== null) reportPattern(node.id, fs);
    },
  };
}
