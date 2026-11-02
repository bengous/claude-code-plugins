import type { ESTree, SourceCode } from "@oxlint/plugins";
import { defineRule } from "@oxlint/plugins";

import { fsMemberVisitors } from "../shared/fs-member.ts";
import {
  WHOLE_MODULE,
  destructuredOf,
  importOf,
  isGlobalNamed,
  loadedModule,
  propertyName,
  valueOf,
} from "../shared/import-binding.ts";
import { isPlatformExempt } from "../shared/platform-exempt.ts";

const WRITES = new Set(["writeFile", "writeFileSync"]);

/** Bun's own streams: `Bun.write` sends to them, no file at a path. */
const BUN_STREAMS = new Set(["stdout", "stderr"]);

/** `bun` whole: the global `Bun`, `bun` imported whole, required or loaded by `await import()`. */
function isBunModule(sourceCode: SourceCode, node: ESTree.Node): boolean {
  const value = valueOf(sourceCode, node);

  if (value.type !== "Identifier") return loadedModule(sourceCode, value) === "bun";

  if (isGlobalNamed(sourceCode, value, "Bun")) return true;
  const binding = importOf(sourceCode, value);

  return binding?.source === "bun" && WHOLE_MODULE.has(binding.imported);
}

/** The export of `bun` that `node` reads: read off `bun` whole, destructured from it, or imported by name. */
function bunExportOf(sourceCode: SourceCode, node: ESTree.Node): string | null {
  const value = valueOf(sourceCode, node);

  if (value.type === "MemberExpression")
    return isBunModule(sourceCode, value.object) ? propertyName(value) : null;

  if (value.type !== "Identifier") return null;
  const binding = importOf(sourceCode, value);

  if (binding !== null)
    return binding.source === "bun" && !WHOLE_MODULE.has(binding.imported)
      ? binding.imported
      : null;
  const part = destructuredOf(sourceCode, value);

  return part !== null && isBunModule(sourceCode, part.init) ? part.key : null;
}

function isFdLiteral(sourceCode: SourceCode, node: ESTree.Node): boolean {
  const value = valueOf(sourceCode, node);

  return value.type === "Literal" && Number.isInteger(value.value);
}

/** An fd written as a number, or `Bun.stdout` and `Bun.stderr`. */
function isStream(sourceCode: SourceCode, node: ESTree.Node): boolean {
  if (isFdLiteral(sourceCode, node)) return true;
  const name = bunExportOf(sourceCode, node);

  return name !== null && BUN_STREAMS.has(name);
}

/** What a `Bun.file(<target>)` call opens; `null` for any other node. */
function bunFileTarget(sourceCode: SourceCode, node: ESTree.Node): ESTree.Node | null {
  const value = valueOf(sourceCode, node);

  if (value.type !== "CallExpression" || bunExportOf(sourceCode, value.callee) !== "file")
    return null;

  return value.arguments[0] ?? null;
}

/**
 * Whether a destination of `Bun.write` is a file at a path: anything but a stream, or a
 * `Bun.file` of one. A variable that holds an fd reads as a path: the AST does not tell them apart.
 */
function isFileDestination(sourceCode: SourceCode, node: ESTree.Node): boolean {
  if (isStream(sourceCode, node)) return false;
  const target = bunFileTarget(sourceCode, node);

  return target === null || !isStream(sourceCode, target);
}

/** Whether an options argument of `writeFile` asks to append: `{ flag: "a…" }`. */
function appends(sourceCode: SourceCode, node: ESTree.Node | undefined): boolean {
  if (node === undefined) return false;
  const value = valueOf(sourceCode, node);

  return (
    value.type === "ObjectExpression" &&
    value.properties.some(
      (property) =>
        property.type === "Property" &&
        !property.computed &&
        property.key.type === "Identifier" &&
        property.key.name === "flag" &&
        property.value.type === "Literal" &&
        String(property.value.value).startsWith("a"),
    )
  );
}

/**
 * Whether `node`, an fs `writeFile` called on the spot, writes through a numbered fd or appends,
 * where `writeAtomic` has nothing to offer. A reference that is not called is reported.
 */
function writesThroughFdOrAppends(sourceCode: SourceCode, node: ESTree.Node): boolean {
  const call = node.parent;

  if (call?.type !== "CallExpression" || call.callee !== node) return false;
  const [target, , options] = call.arguments;

  return (target !== undefined && isFdLiteral(sourceCode, target)) || appends(sourceCode, options);
}

/** Ban a whole file written in place: `writeAtomic` of the platform helpers never leaves it half written. */
export const noRawWriteRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow writing a whole file in place: `writeFile` and `writeFileSync` from `node:fs`, `Bun.write` to a file, `Bun.file(…).write`; use `writeAtomic` or `writeAtomicSync` of the platform helpers.",
    },
    messages: {
      rawWrite:
        "{{what}} writes a whole file in place: use `writeAtomic` or `writeAtomicSync` from `tools/platform/fs.ts` (the directory's own copy in a plugin).",
    },
  },
  create(context) {
    if (isPlatformExempt(context.cwd, context.filename)) return {};
    const { sourceCode } = context;

    const report = (node: ESTree.Node, what: string): void =>
      context.report({ node, messageId: "rawWrite", data: { what } });

    return {
      ...fsMemberVisitors(sourceCode, WRITES, (node, name, source) => {
        if (!writesThroughFdOrAppends(sourceCode, node))
          report(node, `\`${name}\` from \`${source}\``);
      }),
      CallExpression(node) {
        const [destination] = node.arguments;

        if (
          bunExportOf(sourceCode, node.callee) === "write" &&
          destination !== undefined &&
          isFileDestination(sourceCode, destination)
        )
          report(node, "`Bun.write`");

        if (node.callee.type !== "MemberExpression" || propertyName(node.callee) !== "write")
          return;
        const target = bunFileTarget(sourceCode, node.callee.object);

        if (target !== null && !isStream(sourceCode, target)) report(node, "`Bun.file(…).write`");
      },
    };
  },
});
