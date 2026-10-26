import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  blocksOf,
  checkRegistry,
  checkRuleFile,
  type Control,
  controlsOf,
  type Controls,
  type Entry,
  fingerprint,
  lintHeld,
  quoteOf,
  ruleFiles,
  type RuleEntries,
  runsTestFile,
  wiredPaths,
} from "./check-rule-registry.ts";

const repoRoot = join(import.meta.dir, "..");

const FILES = new Set([
  ".claude/hooks/guard.ts",
  ".claude/hooks/orphan.ts",
  "scripts/a.test.ts",
  "scripts/a.ts",
  "vellum/src/a.test.ts",
]);

const CONTROLS: Controls = {
  gates: new Set(["lint-ts", "typecheck"]),
  wired: new Set([".claude/hooks/guard.ts"]),
  lintHeld: (rule) => rule === "no-debugger",
  runsTest: (path) => path === "scripts/a.test.ts",
  exists: (path) => FILES.has(path),
};

function entry(text: string, holding: Partial<Entry>): RuleEntries {
  // SAFETY: the tests spell entries the type refuses, to see the gate refuse them at run time too.
  const spelled = { quote: quoteOf(text), ...holding } as Entry;

  return { [fingerprint(text)]: spelled };
}

function held(text: string, ...controls: string[]): RuleEntries {
  // SAFETY: the tests spell controls the type refuses, to see the gate refuse them at run time too.
  return entry(text, { held: controls as Control[] });
}

function prose(text: string): RuleEntries {
  return entry(text, { prose: "why" });
}

function failures(source: string, entries: RuleEntries): string[] {
  return checkRuleFile({ path: "RULES.md", source }, entries, CONTROLS);
}

describe("blocksOf", () => {
  test("a paragraph, a top-level item and a table row are each a rule", () => {
    const source =
      "Text\non two lines.\n\n- An item\n  wrapped.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n";

    expect(blocksOf(source).filter((block) => block.kind !== "other")).toEqual([
      { kind: "paragraph", line: 1, text: "Text on two lines." },
      { kind: "item", line: 4, text: "An item wrapped." },
      { kind: "row", line: 7, text: "| A | B |" },
      { kind: "row", line: 9, text: "| 1 | 2 |" },
    ]);
  });

  test("an item indented by up to three spaces is top-level, by four it is code", () => {
    expect(blocksOf("   - item\n\n    code\n").map((block) => block.kind)).toEqual([
      "item",
      "other",
    ]);
  });

  test("reads a numbered item as an item, and a nested item as part of its parent", () => {
    expect(blocksOf("1. one\n   - nested\n12) two\n").map((block) => block.text)).toEqual([
      "one - nested",
      "two",
    ]);
  });

  test("ends an item at a paragraph after a blank line, and a paragraph at a heading", () => {
    expect(blocksOf("- one\n\nText\n## Heading\n").map((block) => block.kind)).toEqual([
      "item",
      "paragraph",
      "other",
    ]);
  });

  test("keeps a code span as written", () => {
    expect(blocksOf("- run `bun test`")[0]?.text).toBe("run `bun test`");
  });

  test("skips the frontmatter", () => {
    expect(blocksOf("---\npaths:\n  - x\n---\n\n- rule\n")).toEqual([
      { kind: "item", line: 6, text: "rule" },
    ]);
  });

  test("closes a fence only on its own character, at least as long", () => {
    const source = "~~~\n```\n- not a rule\n```\n~~~\n\n````\n```\n- not either\n````\n\n- rule\n";

    expect(blocksOf(source).filter((block) => block.kind !== "other")).toEqual([
      { kind: "item", line: 12, text: "rule" },
    ]);
  });

  test("leaves an indented fence out of its item's text, the item going on after it", () => {
    const source = "- rule\n\n  ```md\n  - inner\n  ~~~\n  ```\n  tail\n- next\n";

    expect(blocksOf(source)).toEqual([
      { kind: "item", line: 1, text: "rule tail" },
      { kind: "item", line: 8, text: "next" },
    ]);
  });
});

describe("fingerprint", () => {
  test("survives a rewrap of the rule", () => {
    const [wrapped] = blocksOf("- one two\n  three\n");
    const [flat] = blocksOf("- one two three\n");

    expect(fingerprint(wrapped?.text ?? "")).toBe(fingerprint(flat?.text ?? ""));
  });
});

describe("checkRuleFile", () => {
  test("passes a rule whose entry holds controls that are in place", () => {
    const entries = held(
      "A rule.",
      "gate lint-ts",
      "hook .claude/hooks/guard.ts",
      "test scripts/a.test.ts",
      "lint no-debugger",
    );

    expect(failures("- A rule.\n", entries)).toEqual([]);
  });

  test("normalizes a hook's path as the wiring does", () => {
    for (const spelled of [
      "hook ./.claude/hooks/guard.ts",
      "hook $CLAUDE_PROJECT_DIR/.claude/hooks/guard.ts",
      'hook "$CLAUDE_PROJECT_DIR"/.claude/hooks/guard.ts',
    ]) {
      expect(failures("- A rule.\n", held("A rule.", spelled))).toEqual([]);
    }
  });

  test("reads a control written in backticks by its name", () => {
    expect(failures("- A rule.\n", held("A rule.", "gate `lint-ts`"))).toEqual([]);
  });

  test("a paragraph and a table row need an entry too", () => {
    expect(failures("A paragraph.\n\n| a | row |\n|---|---|\n", {})).toEqual([
      expect.stringMatching(/^RULES\.md:1: a rule with no entry/u),
      expect.stringMatching(/^RULES\.md:3: a rule with no entry/u),
    ]);
  });

  test("names the key and the quote to add for a rule with no entry, quotes escaped", () => {
    const text = 'Say "hi".';
    const [failure] = failures(`- ${text}\n`, {});

    expect(failure).toContain(
      `add ${JSON.stringify(fingerprint(text))}: { quote: ${JSON.stringify(quoteOf(text))}`,
    );
    expect(failure).toContain('prose: "<why no tool can hold it>"');
  });

  test("names the edited rule's key for an entry that matches no rule", () => {
    const found = failures("- A rule, edited.\n", held("A rule.", "gate lint-ts"));

    expect(found).toEqual([
      expect.stringMatching(/^RULES\.md:1: a rule with no entry/u),
      expect.stringContaining(
        `entry ${JSON.stringify(fingerprint("A rule."))} ("A rule.") matches no rule. If its rule was edited, move the entry to the edited rule's key (RULES.md:1 ${JSON.stringify(fingerprint("A rule, edited."))})`,
      ),
    ]);
  });

  test("asks to delete an entry that matches no rule when every rule has one", () => {
    expect(failures("Text.\n", { ...prose("Text."), ...held("A rule.", "gate lint-ts") })).toEqual([
      expect.stringContaining("matches no rule. Delete it"),
    ]);
  });

  test("a lead-in covers its list only when its entry says so", () => {
    const source = "Lead-in:\n\n- one\n- two\n\nPointer.\n\n- three\n";
    const pointer = { ...prose("Pointer."), ...prose("three") };

    expect(failures(source, { ...prose("Lead-in:"), ...pointer })).toEqual([
      expect.stringMatching(/^RULES\.md:3: a rule with no entry/u),
      expect.stringMatching(/^RULES\.md:4: a rule with no entry/u),
    ]);

    expect(
      failures(source, { ...entry("Lead-in:", { prose: "why", covers: "list" }), ...pointer }),
    ).toEqual([]);
  });

  test("refuses covers on a rule that opens no list", () => {
    expect(
      failures("Text.\n\n## Next\n", entry("Text.", { prose: "why", covers: "list" })),
    ).toEqual([expect.stringContaining('covers: "list" on a rule that opens no list')]);
  });

  test("refuses a quote that does not open the rule, and gives the right one", () => {
    expect(failures("- A rule.\n", entry("A rule.", { quote: "Another", prose: "why" }))).toEqual([
      expect.stringContaining('its quote does not open the rule; write quote: "A rule."'),
    ]);
  });

  test("refuses an empty reason and an empty held", () => {
    expect(failures("- A rule.\n", entry("A rule.", { prose: " " }))).toEqual([
      expect.stringContaining("prose gives no reason"),
    ]);
    expect(failures("- A rule.\n", held("A rule."))).toEqual([
      expect.stringContaining("held names no control"),
    ]);
  });

  test("names each control that is gone, then the fix", () => {
    const found = failures(
      "- A rule.\n",
      held(
        "A rule.",
        "gate gone",
        "lint no-console",
        "test scripts/gone.test.ts",
        "hook scripts/gone.ts",
        "script scripts/a.ts",
      ),
    );

    expect(found).toEqual([
      expect.stringContaining("no gate gone among the gates of scripts/check-lint-config.ts"),
      expect.stringContaining("oxlint does not set no-console to error repo-wide"),
      expect.stringContaining("no test file scripts/gone.test.ts"),
      expect.stringContaining("no file scripts/gone.ts"),
      expect.stringContaining('"script scripts/a.ts" is no "<gate|hook|lint|test> <name>"'),
    ]);

    for (const failure of found) {
      expect(failure).toContain("Name the control that holds the rule now");
    }
  });

  test("refuses a hook file that no hook runs, and a test file no suite runs", () => {
    expect(
      failures(
        "- A rule.\n",
        held("A rule.", "hook .claude/hooks/orphan.ts", "test vellum/src/a.test.ts"),
      ),
    ).toEqual([
      expect.stringContaining("no hook runs .claude/hooks/orphan.ts"),
      expect.stringContaining("no suite runs vellum/src/a.test.ts"),
    ]);
  });
});

describe("checkRegistry", () => {
  test("refuses a registry group for a file that holds no rules", () => {
    expect(checkRegistry([{ path: "AGENTS.md", source: "" }], { "OLD.md": {} }, CONTROLS)).toEqual([
      expect.stringContaining('"OLD.md" is no rule file'),
    ]);
  });
});

describe("wiredPaths", () => {
  test("reads a path relative to the project, through $CLAUDE_PROJECT_DIR, quoted or not, or ./", () => {
    const paths = wiredPaths([
      'bun "$CLAUDE_PROJECT_DIR/.claude/hooks/a.ts"',
      'bun "$CLAUDE_PROJECT_DIR"/.claude/hooks/b.ts',
      "${CLAUDE_PROJECT_DIR}/.claude/hooks/c.sh",
      "bun ./scripts/d.ts",
    ]);

    for (const path of [
      ".claude/hooks/a.ts",
      ".claude/hooks/b.ts",
      ".claude/hooks/c.sh",
      "scripts/d.ts",
    ]) {
      expect(paths.has(path)).toBe(true);
    }
  });

  test("matches a whole path, never its tail or a longer name", () => {
    const paths = wiredPaths(["bun ./vellum/scripts/run.ts", "bun ./.claude/hooks/guard.tsx"]);

    expect(paths.has("vellum/scripts/run.ts")).toBe(true);
    expect(paths.has("scripts/run.ts")).toBe(false);
    expect(paths.has(".claude/hooks/guard.ts")).toBe(false);
  });
});

describe("runsTestFile", () => {
  const plan = {
    ignorePatterns: ["vellum/**/*.test.ts", "archive/**"],
    extraRoots: [".claude/hooks/"],
    kitDirs: ["vellum/"],
  };

  test("accepts a test of the plain run, of an extra root, and of a plugin's kit", () => {
    expect(runsTestFile("scripts/a.test.ts", plan)).toBe(true);
    expect(runsTestFile("agent-hooks/stop.integration.test.ts", plan)).toBe(true);
    expect(runsTestFile(".claude/hooks/format-on-edit.integration.test.ts", plan)).toBe(true);
    expect(runsTestFile("vellum/src/runtime/hooks/register.test.ts", plan)).toBe(true);
    expect(runsTestFile("vellum/src/page.test.tsx", plan)).toBe(true);
  });

  test("refuses a file the runs skip: no test name, a dot directory, an ignored path", () => {
    expect(runsTestFile("scripts/a.ts", plan)).toBe(false);
    expect(runsTestFile(".claude/other/a.test.ts", plan)).toBe(false);
    expect(runsTestFile("archive/old/a.test.ts", plan)).toBe(false);
    expect(runsTestFile("vellum/e2e/a.e2e.ts", plan)).toBe(false);
    expect(runsTestFile("vellum/node_modules/x/a.test.ts", plan)).toBe(false);
  });
});

describe("lintHeld", () => {
  const lint = {
    rules: {
      "no-debugger": "deny",
      eqeqeq: 2,
      "no-console": "error",
      "max-lines": "off",
      curly: ["error"],
    },
    overrides: [{ "max-lines": ["error", { max: 500 }] }, { "no-console": "off" }],
  };

  test("holds a rule set to error at top level, in any of oxlint's spellings, or through a category", () => {
    for (const rule of ["no-debugger", "eslint/no-debugger", "eqeqeq", "curly"]) {
      expect(lintHeld(rule, lint)).toBe(true);
    }
  });

  test("does not hold a rule an override turns off, or one only an override sets", () => {
    expect(lintHeld("no-console", lint)).toBe(false);
    expect(lintHeld("max-lines", lint)).toBe(false);
    expect(lintHeld("no-alert", lint)).toBe(false);
  });
});

describe("controlsOf", () => {
  let root = "";

  afterEach(() => {
    if (root !== "") rmSync(root, { recursive: true, force: true });
    root = "";
  });

  function write(path: string, text: string): void {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }

  function repo(): void {
    root = mkdtempSync(join(tmpdir(), "rule-registry-"));
    write(".claude-plugin/marketplace.json", '{ "plugins": [{ "source": "./mod" }] }');
    write("mod/hooks/hooks.json", '{ "modules": ["hooks/index.ts"] }');
    write("bunfig.toml", '[test]\npathIgnorePatterns = ["mod/**/*.test.ts"]\n');
  }

  function wiring(): void {
    write(
      ".claude/__settings.jsonc",
      [
        "{",
        "  // .claude/hooks/commented.ts",
        '  "hooks": { "Stop": [{ "hooks": [{ "command": "bun \\"$CLAUDE_PROJECT_DIR\\"/.claude/hooks/run.ts" }] }] },',
        '  "permissions": { "allow": ["Bash(bun ./scripts/allowed.ts *)"] }',
        "}",
      ].join("\n"),
    );
    write(
      ".claude/agent-hooks.jsonc",
      '// scripts/kit-comment.ts\n{ "run": "bun ./scripts/kit.ts" }\n',
    );
    write(
      "lefthook.yml",
      [
        "# scripts/yaml-comment.ts",
        "pre-commit:",
        "  jobs:",
        "    - run: bun ./scripts/job.ts # scripts/trailing.ts",
        "    - group:",
        "        jobs:",
        "          - run: bun ./scripts/grouped.ts",
        "  commands:",
        "    named:",
        "      run: bun ./scripts/command.ts",
        "pre-push:",
        "  jobs:",
        "    - script: push.sh",
        "  scripts:",
        "    other.sh:",
        "      runner: bash",
      ].join("\n"),
    );
    write(
      ".lefthook/pre-push/push.sh",
      "#!/usr/bin/env bash\n# scripts/shell-comment.ts\nbun ./scripts/pushed.ts\n",
    );
    write(".lefthook/pre-push/other.sh", "#!/usr/bin/env bash\nbun ./scripts/other.ts\n");
    write(
      "mod/hooks/hooks.json",
      JSON.stringify({
        modules: ["hooks/index.ts"],
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { type: "command", command: 'bun "${CLAUDE_PLUGIN_ROOT}/guard.ts" pre-bash' },
              ],
            },
          ],
        },
      }),
    );
  }

  test("reads every command a hook or a catalog plugin runs, and no path a comment or a permission names", async () => {
    repo();
    wiring();
    const controls = await controlsOf(root, { "AGENTS.md": held("x", "hook scripts/job.ts") });

    for (const path of [
      ".claude/hooks/run.ts",
      "scripts/kit.ts",
      "scripts/job.ts",
      "scripts/grouped.ts",
      "scripts/command.ts",
      ".lefthook/pre-push/push.sh",
      "scripts/pushed.ts",
      ".lefthook/pre-push/other.sh",
      "scripts/other.ts",
      "mod/guard.ts",
    ]) {
      expect([path, controls.wired.has(path)]).toEqual([path, true]);
    }

    for (const path of [
      ".claude/hooks/commented.ts",
      "scripts/allowed.ts",
      "scripts/kit-comment.ts",
      "scripts/yaml-comment.ts",
      "scripts/trailing.ts",
      "scripts/shell-comment.ts",
      "guard.ts",
    ]) {
      expect([path, controls.wired.has(path)]).toEqual([path, false]);
    }
  });

  test("reads no hook wiring when no entry names a hook", async () => {
    repo();
    const controls = await controlsOf(root, { "AGENTS.md": held("x", "gate test-mod") });

    expect(controls.gates.has("test-mod")).toBe(true);
    expect(controls.wired.size).toBe(0);
    await expect(
      controlsOf(root, { "AGENTS.md": held("x", "hook scripts/a.ts") }),
    ).rejects.toThrow();
  });

  test("a test of a hooks module's kit runs, bunfig's ignore aside", async () => {
    repo();
    const controls = await controlsOf(root, {});

    expect(controls.runsTest("mod/hooks/a.test.ts")).toBe(true);
    expect(controls.runsTest("other/a.test.ts")).toBe(true);
    expect(controls.runsTest("mod/e2e/a.e2e.ts")).toBe(false);
  });
});

describe("ruleFiles", () => {
  test("cover the root AGENTS.md and every file of .claude/rules", () => {
    expect(ruleFiles(repoRoot)).toContain("AGENTS.md");
    expect(ruleFiles(repoRoot)).toContain(".claude/rules/hook-ladder.md");
  });
});
