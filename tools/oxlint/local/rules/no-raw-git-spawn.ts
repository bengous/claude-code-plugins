import type { ESTree, SourceCode } from "@oxlint/plugins";
import { defineRule } from "@oxlint/plugins";

import { constValueOf, importOf, isGlobalNamed } from "../shared/import-binding.ts";
import { isPlatformExempt } from "../shared/platform-exempt.ts";

const BUN_SPAWNS = new Set(["spawn", "spawnSync"]);

const CHILD_PROCESS = new Set(["node:child_process", "child_process"]);

const NODE_SPAWNS = new Set(["spawn", "spawnSync", "execFile", "execFileSync"]);

const WHOLE_MODULE = new Set(["*", "default"]);

/** A shell line of bun's `$` that runs git: `git`, alone or before a space. */
const GIT_LINE = /^\s*git(?:\s|$)/u;

function propertyName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) return node.property.type === "Identifier" ? node.property.name : null;

  return node.property.type === "Literal" && node.property.value !== null
    ? String(node.property.value)
    : null;
}

/** `node` itself, or the `const` value it names. */
function valueOf(sourceCode: SourceCode, node: ESTree.Node): ESTree.Node {
  return node.type === "Identifier" ? (constValueOf(sourceCode, node) ?? node) : node;
}

function isGitWord(sourceCode: SourceCode, node: ESTree.Node | null | undefined): boolean {
  if (node === null || node === undefined) return false;
  const value = valueOf(sourceCode, node);

  if (value.type === "Literal") return value.value === "git";

  return (
    value.type === "TemplateLiteral" &&
    value.expressions.length === 0 &&
    value.quasis[0]?.value.cooked === "git"
  );
}

/**
 * An argv that starts with `git`: an array literal, a `const` one, one spread first into another,
 * or `{ cmd }` holding any of these.
 */
function isGitArgv(sourceCode: SourceCode, node: ESTree.Node | null | undefined): boolean {
  if (node === null || node === undefined) return false;
  const value = valueOf(sourceCode, node);

  if (value.type === "ArrayExpression") {
    const [first] = value.elements;

    return first?.type === "SpreadElement"
      ? isGitArgv(sourceCode, first.argument)
      : isGitWord(sourceCode, first);
  }

  if (value.type !== "ObjectExpression") return false;

  return value.properties.some(
    (property) =>
      property.type === "Property" &&
      !property.computed &&
      property.key.type === "Identifier" &&
      property.key.name === "cmd" &&
      isGitArgv(sourceCode, property.value),
  );
}

/** Which spawner a callee is, by where it comes from: Bun's, `node:child_process`'s, or none. */
function spawnerOf(sourceCode: SourceCode, callee: ESTree.Node): "bun" | "node" | null {
  if (callee.type === "Identifier") {
    const binding = importOf(sourceCode, callee);

    if (binding?.source === "bun" && BUN_SPAWNS.has(binding.imported)) return "bun";

    return binding !== null &&
      CHILD_PROCESS.has(binding.source) &&
      NODE_SPAWNS.has(binding.imported)
      ? "node"
      : null;
  }

  if (callee.type !== "MemberExpression" || callee.object.type !== "Identifier") return null;
  const name = propertyName(callee) ?? "";
  const { object } = callee;

  if (isGlobalNamed(sourceCode, object, "Bun") && BUN_SPAWNS.has(name)) return "bun";
  const binding = importOf(sourceCode, object);

  if (binding === null || !WHOLE_MODULE.has(binding.imported)) return null;

  if (binding.source === "bun" && BUN_SPAWNS.has(name)) return "bun";

  return CHILD_PROCESS.has(binding.source) && NODE_SPAWNS.has(name) ? "node" : null;
}

/** Whether a tag is bun's `$`: imported from `bun`, or `Bun.$`. */
function isBunShell(sourceCode: SourceCode, tag: ESTree.Node): boolean {
  if (tag.type === "Identifier") {
    const binding = importOf(sourceCode, tag);

    return binding?.source === "bun" && binding.imported === "$";
  }

  return (
    tag.type === "MemberExpression" &&
    propertyName(tag) === "$" &&
    tag.object.type === "Identifier" &&
    isGlobalNamed(sourceCode, tag.object, "Bun")
  );
}

/** Ban a git started by hand: `git`, `gitRead` and their sync forms run it with the platform's contract. */
export const noRawGitSpawnRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow spawning git through Bun.spawn, bun's $ or node:child_process; use `git` or `gitRead` of the platform helpers.",
    },
    messages: {
      rawGitSpawn:
        "git started through {{how}}: use `git`, `gitRead` or their sync forms from `tools/platform/node.ts` (the directory's own copy in a plugin).",
    },
  },
  create(context) {
    if (isPlatformExempt(context.cwd, context.filename)) return {};
    const { sourceCode } = context;

    return {
      CallExpression(node) {
        const spawner = spawnerOf(sourceCode, node.callee);
        const [first] = node.arguments;

        if (spawner === "bun" && isGitArgv(sourceCode, first))
          context.report({ node, messageId: "rawGitSpawn", data: { how: "Bun.spawn" } });

        if (spawner === "node" && isGitWord(sourceCode, first))
          context.report({ node, messageId: "rawGitSpawn", data: { how: "node:child_process" } });
      },
      TaggedTemplateExpression(node) {
        const head = node.quasi.quasis[0]?.value.cooked ?? "";

        if (isBunShell(sourceCode, node.tag) && GIT_LINE.test(head))
          context.report({ node, messageId: "rawGitSpawn", data: { how: "bun's $" } });
      },
    };
  },
});
