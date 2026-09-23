import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { engineExtensions } from "../../extensions/engine.ts";

/**
 * `register.ts` read as text, as `claude plugin validate` reads a matcher: as written. An
 * unmatched `tool.call` hook wraps every tool call of every agent in the session, and a
 * worktree-isolated agent's shell loses its working directory inside it.
 */

const SOURCE = readFileSync(join(import.meta.dir, "register.ts"), "utf8");

/** What each `on("tool.call", …)` writes before its hook's arrow, comments left out: the matcher, then the parameters. */
const TOOL_CALLS = [...SOURCE.matchAll(/\bon\(\s*"tool\.call",([\s\S]*?)=>/gu)].map((m) =>
  (m[1] ?? "").replaceAll(/\/\/[^\n]*/gu, "").trim(),
);

describe("the tool.call hooks of register.ts", () => {
  test("each one has a matcher", () => {
    expect(TOOL_CALLS.length).toBeGreaterThan(0);
    expect(TOOL_CALLS.filter((head) => !head.startsWith("{ tool: "))).toEqual([]);
  });

  test("their matchers name vellum's own tools and the registry's refusals, and nothing else", () => {
    const named = TOOL_CALLS.flatMap((head) => [...head.matchAll(/"([^"]+)"/gu)].map((m) => m[1]));

    const registry = engineExtensions.flatMap((extension) => [
      ...(extension.tools ?? []).map((tool) => `mcp__vellum__${tool.name}`),
      ...Object.keys(extension.refuses ?? {}),
    ]);

    expect(named.toSorted()).toEqual(["mcp__vellum__submit", ...registry].toSorted());
  });
});
