/*
 * `resolveVariable` and the import-binding test of `importOf` are adapted from the anti-slop
 * pack's `shared/scope.ts` and `rules/no-module-mocking.ts` (vendored in tools/oxlint/anti-slop/),
 * under its license:
 *
 * MIT License
 *
 * Copyright (c) 2026 Dillon Mulroy
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

/** Any node of type `Identifier`: a reference, a binding, a property's name. */
export type IdentifierNode = Extract<ESTree.Node, { readonly type: "Identifier" }>;

/** Resolves an identifier to its binding by walking the lexical scopes upward. */
export function resolveVariable(
  sourceCode: SourceCode,
  identifier: IdentifierNode,
): Variable | null {
  let scope: Scope | null = sourceCode.getScope(identifier);

  while (scope !== null) {
    const variable = scope.set.get(identifier.name);

    if (variable !== undefined) return variable;
    scope = scope.upper;
  }

  return null;
}

/**
 * The binding `identifier` reads, `null` when it reads none: a property's name or an object's key
 * is spelled like a binding but is no reference to it.
 */
function referencedVariable(sourceCode: SourceCode, identifier: IdentifierNode): Variable | null {
  const variable = resolveVariable(sourceCode, identifier);

  return variable?.references.some((reference) => reference.identifier === identifier) === true
    ? variable
    : null;
}

/**
 * Whether `identifier` reads the global `name`: a declared global, or a name no binding of the file
 * declares, as a runtime global (`Bun`) is to a config that names no environment.
 */
export function isGlobalNamed(
  sourceCode: SourceCode,
  identifier: IdentifierNode,
  name: string,
): boolean {
  if (identifier.name !== name) return false;

  if (sourceCode.isGlobalReference(identifier)) return true;
  const variable = resolveVariable(sourceCode, identifier);

  return variable === null || variable.defs.length === 0;
}

/** What an import binds: the module, and the name it takes from it, `default` or `*` for the whole. */
export type ImportedName = { readonly source: string; readonly imported: string };

function nameOf(node: ESTree.Node): string | null {
  switch (node.type) {
    case "ImportSpecifier":
      return node.imported.type === "Identifier" ? node.imported.name : node.imported.value;
    case "ImportDefaultSpecifier":
      return "default";
    case "ImportNamespaceSpecifier":
      return "*";
    default:
      return null;
  }
}

/** The import `identifier` reads, or `null` when it reads a local or a global binding. */
export function importOf(sourceCode: SourceCode, identifier: IdentifierNode): ImportedName | null {
  const variable = referencedVariable(sourceCode, identifier);

  for (const definition of variable?.defs ?? []) {
    if (definition.type !== "ImportBinding" || definition.parent?.type !== "ImportDeclaration")
      continue;
    const imported = nameOf(definition.node);

    if (imported !== null) return { source: definition.parent.source.value, imported };
  }

  return null;
}

/**
 * The value a `const` binding read by `identifier` is initialised with, past `as` and
 * `satisfies`; `null` for any other binding.
 */
export function constValueOf(
  sourceCode: SourceCode,
  identifier: IdentifierNode,
): ESTree.Expression | null {
  const variable = referencedVariable(sourceCode, identifier);
  const [definition] = variable?.defs ?? [];

  if (
    variable?.defs.length !== 1 ||
    definition?.type !== "Variable" ||
    definition.node.type !== "VariableDeclarator" ||
    definition.parent?.type !== "VariableDeclaration" ||
    definition.parent.kind !== "const"
  )
    return null;

  let init = definition.node.init;

  while (init?.type === "TSAsExpression" || init?.type === "TSSatisfiesExpression")
    init = init.expression;

  return init ?? null;
}
