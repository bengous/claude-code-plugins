import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  buildContract,
  checkAntiSlopRules,
  checkCategories,
  checkCommandParity,
  checkIgnorePatterns,
  checkJsPlugins,
  ciCommands,
  EXPECTED_COMMANDS,
  lefthookCommands,
  registeredRuleNames,
  sortKeys,
  unifiedDiff,
} from "./check-lint-config.ts";

const repoRoot = join(import.meta.dir, "..");

const GOOD_CATEGORIES = { correctness: "error", suspicious: "error", pedantic: "error" };
const GOOD_PLUGINS = [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }];
const GOOD_PATTERNS = ["archive/**", "_docs/**", "node_modules/**"];

describe("checkCategories", () => {
  test("passes when the three categories are errors", () => {
    expect(checkCategories(GOOD_CATEGORIES)).toEqual([]);
  });

  test("fails a category lowered to warn", () => {
    const failures = checkCategories({ ...GOOD_CATEGORIES, pedantic: "warn" });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("categories.pedantic");
  });

  test("fails a category that disappeared", () => {
    expect(checkCategories({ correctness: "error", suspicious: "error" })).toHaveLength(1);
  });
});

describe("checkJsPlugins", () => {
  test("passes on the exact registration", () => {
    expect(checkJsPlugins(GOOD_PLUGINS)).toEqual([]);
  });

  test("fails when the plugin is dropped", () => {
    expect(checkJsPlugins([])).toHaveLength(1);
  });

  test("fails a rewritten specifier", () => {
    expect(checkJsPlugins([{ name: "anti-slop", specifier: "./elsewhere.ts" }])).toHaveLength(1);
  });
});

describe("checkIgnorePatterns", () => {
  test("passes a subset of the allowlist", () => {
    expect(checkIgnorePatterns(GOOD_PATTERNS)).toEqual([]);
  });

  test("fails a freshly added pattern", () => {
    const failures = checkIgnorePatterns([...GOOD_PATTERNS, "scripts/**"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("scripts/**");
  });
});

describe("registeredRuleNames", () => {
  test("reads the keys of the vendored registry", () => {
    const source = [
      "const plugin = eslintCompatPlugin({",
      '\tmeta: { name: "anti-slop" },',
      "\trules: {",
      '\t\t"no-reflect-get": noReflectGetRule,',
      '\t\t"no-widen-then-assert": noWidenThenAssertRule,',
      "\t},",
      "});",
    ].join("\n");
    expect(registeredRuleNames(source)).toEqual(["no-reflect-get", "no-widen-then-assert"]);
  });

  test("reads every rule the repo actually vendors", async () => {
    const source = await Bun.file(join(repoRoot, "tools/oxlint/anti-slop/index.ts")).text();
    expect(registeredRuleNames(source)).toHaveLength(15);
  });
});

describe("checkAntiSlopRules", () => {
  const files = ["no-reflect-get", "no-widen-then-assert"];
  const registered = ["no-reflect-get", "no-widen-then-assert"];
  const configured = {
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-widen-then-assert": "error",
  };

  test("passes when the three sets agree", () => {
    expect(checkAntiSlopRules(files, registered, configured)).toEqual([]);
  });

  test("fails a rule de-registered from index.ts", () => {
    const failures = checkAntiSlopRules(files, ["no-reflect-get"], configured);
    expect(failures.join("\n")).toContain("no-widen-then-assert");
  });

  test("fails a rule left out of the config", () => {
    const failures = checkAntiSlopRules(files, registered, {
      "anti-slop/no-reflect-get": "error",
    });
    expect(failures.join("\n")).toContain("not configured");
  });

  test("fails a rule added to the pack but never configured", () => {
    const failures = checkAntiSlopRules([...files, "no-smuggled-rule"], registered, configured);
    expect(failures.join("\n")).toContain("no-smuggled-rule");
  });

  test("fails a rule downgraded from error", () => {
    const failures = checkAntiSlopRules(files, registered, {
      ...configured,
      "anti-slop/no-reflect-get": "warn",
    });
    expect(failures.join("\n")).toContain('expected "error"');
  });
});

describe("checkCommandParity", () => {
  const lefthookRuns = EXPECTED_COMMANDS.map((pair) => pair.lefthook);
  const ciRuns = EXPECTED_COMMANDS.map((pair) => pair.ci);

  test("passes when both files carry every expected pair", () => {
    expect(checkCommandParity(lefthookRuns, ciRuns)).toEqual([]);
  });

  test("fails a gate dropped from lefthook.yml", () => {
    const failures = checkCommandParity(lefthookRuns.slice(1), ciRuns);
    expect(failures.join("\n")).toContain("lefthook.yml runs no");
  });

  test("fails a gate dropped from ci.yml", () => {
    const failures = checkCommandParity(lefthookRuns, ciRuns.slice(1));
    expect(failures.join("\n")).toContain("ci.yml runs no");
  });

  test("fails an argument changed on one side only", () => {
    const weakened = ciRuns.map((run) => (run === "bun x oxlint" ? "bun x oxlint --quiet" : run));
    expect(checkCommandParity(lefthookRuns, weakened)).toHaveLength(1);
  });

  test("fails when --update reaches a hook or CI", () => {
    const smuggled = [...lefthookRuns, "bun ./scripts/check-lint-config.ts --update"];
    expect(checkCommandParity(smuggled, ciRuns).join("\n")).toContain("--update");
  });

  test("passes against the real lefthook.yml and ci.yml", async () => {
    const lefthook = await Bun.file(join(repoRoot, "lefthook.yml")).text();
    const ci = await Bun.file(join(repoRoot, ".github/workflows/ci.yml")).text();
    expect(checkCommandParity(lefthookCommands(lefthook), ciCommands(ci))).toEqual([]);
  });
});

describe("sortKeys", () => {
  test("orders keys at every depth and leaves arrays alone", () => {
    const sorted = sortKeys({ b: 1, a: { d: [3, 1], c: true } });
    expect(JSON.stringify(sorted)).toBe('{"a":{"c":true,"d":[3,1]},"b":1}');
  });

  test("builds a contract that ends with a newline", () => {
    expect(buildContract({ b: 1, a: 2 })).toBe('{\n  "a": 2,\n  "b": 1\n}\n');
  });
});

describe("unifiedDiff", () => {
  test("marks the line that moved", () => {
    expect(unifiedDiff("a\nb\nc", "a\nB\nc")).toBe("  a\n- b\n+ B\n  c");
  });

  test("is empty for identical text", () => {
    expect(unifiedDiff("a\nb", "a\nb")).toBe("");
  });

  test("elides the stretches no change touches", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n");
    const after = before.replace("a", "A").replace("j", "J");
    expect(unifiedDiff(before, after).split("\n")).toEqual([
      "- a",
      "+ A",
      "  b",
      "  c",
      "  d",
      "  ...",
      "  g",
      "  h",
      "  i",
      "- j",
      "+ J",
    ]);
  });
});
