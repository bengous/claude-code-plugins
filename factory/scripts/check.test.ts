import { describe, expect, test } from "bun:test";

import { evaluate, type Facts, format, parseRepositoryLines, parseRuleLines } from "./check.ts";

const COMPLETE: Facts = {
  repo: "o/r",
  defaultBranch: "main",
  allowAutoMerge: true,
  labels: new Set(["ready", "in-progress", "blocked", "owner-ok", "bug"]),
  rules: parseRuleLines(
    [
      "ruleset 7",
      "threads",
      "ruleset 7",
      "check test",
      "check review",
      "check owner-gate",
      "ruleset 7",
      "queue",
      "ruleset 7",
    ].join("\n"),
  ),
  secrets: new Set(["CLAUDE_CODE_OAUTH_TOKEN", "ROUTINE_FIRE_TOKEN"]),
};

const NO_RULES = parseRuleLines("");

describe("evaluate", () => {
  test("a repository set up like the trial is all ok", () => {
    const items = evaluate(COMPLETE);

    expect(items).toHaveLength(12);
    expect(items.filter((item) => !item.ok)).toEqual([]);
  });

  test("a bare repository misses every item, each with its fix", () => {
    const bare: Facts = {
      ...COMPLETE,
      allowAutoMerge: false,
      labels: new Set(),
      rules: NO_RULES,
      secrets: new Set(),
    };

    expect(format(evaluate(bare))).toBe(
      [
        "missing  label ready: gh label create ready --repo o/r --description 'The owner hands this issue to the factory'",
        "missing  label in-progress: gh label create in-progress --repo o/r --description 'A factory session works on this issue'",
        "missing  label blocked: gh label create blocked --repo o/r --description 'Stopped by something outside the issue'",
        "missing  label owner-ok: gh label create owner-ok --repo o/r --description 'The owner approves this pull request'\\''s owner paths'",
        "missing  main requires the check test: gh api -X POST repos/o/r/rulesets --input ruleset.json",
        "missing  main requires the check review: gh api -X POST repos/o/r/rulesets --input ruleset.json",
        "missing  main requires the check owner-gate: gh api -X POST repos/o/r/rulesets --input ruleset.json",
        "missing  main requires resolved review threads: gh api -X POST repos/o/r/rulesets --input ruleset.json",
        "missing  main has a merge queue: gh api -X POST repos/o/r/rulesets --input ruleset.json",
        "missing  auto-merge allowed: gh repo edit o/r --enable-auto-merge",
        "missing  secret CLAUDE_CODE_OAUTH_TOKEN: gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo o/r",
        "missing  secret ROUTINE_FIRE_TOKEN: gh secret set ROUTINE_FIRE_TOKEN --repo o/r",
      ].join("\n"),
    );
  });

  test("an existing repository ruleset is updated in place", () => {
    const missing = evaluate({ ...COMPLETE, rules: parseRuleLines("ruleset 9\n") }).filter(
      (item) => !item.ok,
    );

    expect(missing.map(({ name }) => name)).toEqual([
      "main requires the check test",
      "main requires the check review",
      "main requires the check owner-gate",
      "main requires resolved review threads",
      "main has a merge queue",
    ]);
    expect(new Set(missing.map(({ fix }) => fix))).toEqual(
      new Set(["gh api -X PUT repos/o/r/rulesets/9 --input ruleset.json"]),
    );
  });

  test("an auto-merge setting the token cannot see is missing and says so", () => {
    const [item] = evaluate({ ...COMPLETE, allowAutoMerge: null }).filter((entry) => !entry.ok);

    expect(item?.name).toBe("auto-merge allowed (not visible to this token)");
  });
});

describe("parseRuleLines", () => {
  test("keeps the first repository ruleset and every check", () => {
    expect(parseRuleLines("ruleset 3\ncheck a b\nruleset 4\nqueue\n")).toEqual({
      checks: new Set(["a b"]),
      threadsResolved: false,
      mergeQueue: true,
      rulesetId: "3",
    });
  });

  test("refuses a line it does not know", () => {
    expect(() => parseRuleLines("deletion\n")).toThrow("a line it should not: deletion");
  });
});

describe("parseRepositoryLines", () => {
  test.each([
    ["main\ntrue\n", true],
    ["main\nfalse\n", false],
    ["main\nunknown\n", null],
    ["main\nnull\n", null],
  ])("%p", (text, allowAutoMerge) => {
    expect(parseRepositoryLines(text)).toEqual({ defaultBranch: "main", allowAutoMerge });
  });

  test("refuses an answer missing a line", () => {
    expect(() => parseRepositoryLines("main\n")).toThrow("the repository query printed");
  });
});
