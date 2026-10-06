import { describe, expect, test } from "bun:test";

import { findFrozenFacts, isCandidate } from "./check-frozen-facts.ts";

async function facts(path: string, contents: string): Promise<string[]> {
  const hits = await findFrozenFacts(path, contents);

  return hits.map((hit) => `${hit.line}: ${hit.text}`);
}

describe("isCandidate", () => {
  test("accepts Markdown, shell and extensionless files", () => {
    for (const path of ["docs/a.md", "a.sh", "scripts/publish-live"]) {
      expect(isCandidate(path)).toBe(true);
    }
  });

  test("leaves scripts to the lint rule, and rejects the other extensions", () => {
    for (const path of ["a.ts", "a.tsx", "a.js", "a.json", "a.yml", "a.png"]) {
      expect(isCandidate(path)).toBe(false);
    }
  });

  test("rejects what the other gates exclude", () => {
    expect(isCandidate("archive/a/README.md")).toBe(false);
    expect(isCandidate("node_modules/a/README.md")).toBe(false);
    expect(isCandidate("tools/oxlint/anti-slop/README.md")).toBe(false);
    expect(isCandidate(".claude/worktrees/agent/docs/a.md")).toBe(false);
  });

  test("rejects the allowlist", () => {
    expect(isCandidate("vellum/CHANGELOG.md")).toBe(false);
    expect(isCandidate("CHANGELOG.md")).toBe(false);
    expect(isCandidate("vellum/e2e/fixtures/grill-real/plan.md")).toBe(false);
    expect(isCandidate("scripts/__tests__/fixtures/valid/README.md")).toBe(false);
  });
});

describe("Markdown", () => {
  test("reports each fact on its line", async () => {
    const text =
      "# Title\n\nMeasured on Claude Code 2.1.287.\n\nIn run 37004299897 and 35859775898.\n";

    expect(await facts("a.md", text)).toEqual(["3: 2.1.287", "5: 37004299897", "5: 35859775898"]);
  });

  test("reports nothing in a clean file", async () => {
    expect(await facts("a.md", "lefthook 2.1.12, gh 2.99.0, released 2026-10-06\n")).toEqual([]);
  });
});

describe("shell comments", () => {
  test("a # comment", async () => {
    expect(await facts("a.sh", "#!/usr/bin/env bash\nx=1 # measured on 2.1.284\n")).toEqual([
      "2: 2.1.284",
    ]);
  });

  test("an extensionless script, by its shebang", async () => {
    expect(await facts("scripts/tool", "#!/bin/sh\n# on 2.1.284\n")).toEqual(["2: 2.1.284"]);
  });

  test("an extensionless file with no shell shebang is not read", async () => {
    expect(await facts("scripts/tool", "#!/usr/bin/env bun\n// on 2.1.284\n")).toEqual([]);
  });

  test("not a string, a heredoc or a parameter length", async () => {
    const source = [
      "#!/usr/bin/env bash",
      `echo "# 2.1.287" '# 2.1.287' \${#x} $#`,
      "cat <<EOF",
      "# 2.1.287",
      "EOF",
    ].join("\n");

    expect(await facts("a.sh", source)).toEqual([]);
  });
});
