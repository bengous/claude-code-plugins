import { describe, expect, test } from "bun:test";

import { isE2ePath } from "./e2e-paths.ts";

describe("isE2ePath", () => {
  test("keeps each path the suite loads", () => {
    for (const path of [
      "vellum/src/runtime/page/app.tsx",
      "vellum/e2e/labels.e2e.ts",
      "vellum/e2e/fixtures/rich/plan.md",
      "vellum/src/steps/grill/grilling.md",
      "vellum/package.json",
      "docs/plugin-testing.md",
      "mise.toml",
      ".github/workflows/ci.yml",
    ]) {
      expect([path, isE2ePath(path)]).toEqual([path, true]);
    }
  });

  test("keeps a new directory under vellum/", () => {
    expect(isE2ePath("vellum/fresh/thing.ts")).toBe(true);
  });

  test("leaves out each path the suite never loads", () => {
    for (const path of [
      "vellum/src/runtime/hooks/hooks.ts",
      "vellum/src/runtime/hooks/deep/state.ts",
      "vellum/src/steps/grill/hooks.ts",
      "vellum/src/review/hooks.ts",
      "vellum/scripts/contract-diff.ts",
      "vellum/hooks/hooks.json",
      "vellum/skills/start/SKILL.md",
      "vellum/agents/plan-reviewer.md",
      "vellum/types/claude-code.d.ts",
      "vellum/.claude/rules/page.md",
      "vellum/.claude-plugin/plugin.json",
      "vellum/README.md",
      "vellum/AGENTS.md",
      "vellum/src/runtime/page/app.spec.ts",
      "vellum/src/runtime/server/routes.test.ts",
    ]) {
      expect([path, isE2ePath(path)]).toEqual([path, false]);
    }
  });

  test("leaves out a path outside the list", () => {
    for (const path of [
      "README.md",
      "docs/repo-ops/checks.md",
      ".github/workflows/other.yml",
      "scripts/gates/run-gates.ts",
      "archive/vellum/src/page.tsx",
    ]) {
      expect([path, isE2ePath(path)]).toEqual([path, false]);
    }
  });

  test("keeps a part's file that is not its hooks half", () => {
    expect(isE2ePath("vellum/src/steps/grill/page.tsx")).toBe(true);
  });

  test("keeps the review's file that is not its hooks code", () => {
    expect(isE2ePath("vellum/src/review/comments.tsx")).toBe(true);
  });
});
