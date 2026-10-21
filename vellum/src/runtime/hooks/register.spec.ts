import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { engineExtensions } from "./slices.ts";

/**
 * `register.ts` read as text, as `claude plugin validate` reads a matcher: as written. An
 * unmatched `tool.call` hook wraps every tool call of every agent in the session, and a
 * worktree-isolated agent's shell loses its working directory inside it.
 */

const SOURCE = readFileSync(join(import.meta.dir, "register.ts"), "utf8");

/**
 * What each `on("tool.call", …)` writes before its hook's arrow, comments left out and spaces
 * folded, so a literal the formatter wrapped over several lines reads as one: the matcher, then
 * the parameters.
 */
const TOOL_CALLS = [...SOURCE.matchAll(/\bon\(\s*"tool\.call",([\s\S]*?)=>/gu)].map((m) =>
  (m[1] ?? "")
    .replaceAll(/\/\/[^\n]*/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim(),
);

/**
 * Each `on("tool.call", …)` registration, from its matcher to the next hook's `on(`, in the
 * order of `TOOL_CALLS`. The formatter puts the registration's own `.catch` at the indentation of
 * its `on(`, deeper than any `.catch` inside the hook.
 */
const REGISTRATIONS = SOURCE.split(/^ {2}on\(/mu).filter((part) =>
  part.trimStart().startsWith('"tool.call"'),
);

describe("the tool.call hooks of register.ts", () => {
  test("each one has a matcher", () => {
    expect(TOOL_CALLS.length).toBeGreaterThan(0);
    expect(TOOL_CALLS.filter((head) => !head.startsWith("{ tool: "))).toEqual([]);
  });

  test("each one carries its own .catch: a tool.call hook that fails falls to the engine's permission prompt", () => {
    const caught = REGISTRATIONS.map((part) => /^ {2}\}?\)\.catch\(/mu.test(part));

    expect(caught).toHaveLength(TOOL_CALLS.length);
    expect(TOOL_CALLS.filter((_, index) => caught[index] !== true)).toEqual([]);
  });

  test("their matchers name vellum's own tools and the registry's refusals, and nothing else", () => {
    const named = TOOL_CALLS.flatMap((head) => [...head.matchAll(/"([^"]+)"/gu)].map((m) => m[1]));

    const registry = engineExtensions.flatMap((extension) => [
      ...(extension.tools ?? []).map((tool) => `mcp__vellum__${tool.name}`),
      ...Object.keys(extension.refuses ?? {}),
    ]);

    expect(named.toSorted()).toEqual(
      ["mcp__vellum__submit", "mcp__vellum__state", ...registry].toSorted(),
    );
  });

  test("each tool name is vellum's once: the hook serves the first extension that names it", () => {
    const names = [
      "submit",
      "state",
      ...engineExtensions.flatMap((extension) => (extension.tools ?? []).map(({ name }) => name)),
    ];

    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
    expect(names).not.toContain("grill_suggest");
  });
});
