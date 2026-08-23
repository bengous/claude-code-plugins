import { describe, expect, test } from "bun:test";

import { isLintable, parseFilePath, toRepoRelative } from "./format-and-lint.ts";

describe("parseFilePath", () => {
  test("reads tool_input.file_path", () => {
    expect(parseFilePath(JSON.stringify({ tool_input: { file_path: "/repo/a.ts" } }))).toBe(
      "/repo/a.ts",
    );
  });

  test("returns null on a payload without a path", () => {
    expect(parseFilePath(JSON.stringify({ tool_input: {} }))).toBeNull();
  });

  test("returns null on invalid JSON", () => {
    expect(parseFilePath("not json")).toBeNull();
  });
});

describe("toRepoRelative", () => {
  test("strips the repo root", () => {
    expect(toRepoRelative("/repo/scripts/a.ts", "/repo")).toBe("scripts/a.ts");
  });

  test("tolerates a trailing slash on the root", () => {
    expect(toRepoRelative("/repo/scripts/a.ts", "/repo/")).toBe("scripts/a.ts");
  });

  test("returns null for a file outside the repo", () => {
    expect(toRepoRelative("/elsewhere/a.ts", "/repo")).toBeNull();
  });

  test("passes a relative path through", () => {
    expect(toRepoRelative("scripts/a.ts", "/repo")).toBe("scripts/a.ts");
  });
});

describe("isLintable", () => {
  test("accepts the four script extensions", () => {
    for (const path of ["a.ts", "a.js", "a.mjs", "a.cjs"]) {
      expect(isLintable(path)).toBe(true);
    }
  });

  test("rejects other extensions", () => {
    for (const path of ["a.md", "a.json", "a.sh", "a"]) {
      expect(isLintable(path)).toBe(false);
    }
  });

  test("rejects the paths oxlint ignores", () => {
    expect(isLintable("archive/plugin/a.ts")).toBe(false);
    expect(isLintable("node_modules/pkg/a.js")).toBe(false);
    expect(isLintable("tools/oxlint/anti-slop/index.ts")).toBe(false);
    expect(isLintable("claude-meta-tools/scripts/prompt-extractor/promptExtractor.js")).toBe(false);
  });

  test("accepts repo source, dot directories included", () => {
    expect(isLintable("scripts/validate-marketplace.ts")).toBe(true);
    expect(isLintable(".claude/hooks/guard-destructive.ts")).toBe(true);
  });
});
