import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

// oxlint's RuleTester refuses to run under Bun, so the rule runs through the
// lint gate's own command, on files written to a temporary directory.
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

const PLUGIN = join(import.meta.dir, "..", "index.ts");

const SOURCES = {
  "strings.ts": [
    `const a = "Claude Code 2.1.287";`,
    "const b = '2.1.287';",
    "const c = `run ${a} 35858620580\n2.1.287`;",
    `const d = "// 2.1.287";`,
  ].join("\n"),
  "regex.js": `const re = /"\\/\\/ 2.1.287/u;\n`,
  "jsx-text.tsx": `const a = <p>Don't // 2.1.287</p>;\nconst b = <A t="2.1.287" />;\n`,
  "other-numbers.ts": "// lefthook 2.1.12, at 1758821481\nconst x = 1;\n",
  "line.ts": "const x = 1;\nconst y = 2; // measured on 2.1.270\n",
  "doc-block.ts":
    "/**\n * Shape measured\n * on 2.1.270, in run 37004299897.\n */\nexport const x = 1;\n",
  "interpolation.ts": "const s = `a ${b /* 2.1.270 */} c`;\n",
  "after-quotes.js": `const n = a / b; // on 2.1.288\nconst q = "'"; // on 2.1.289\n`,
  "jsx-comment.tsx": `const a = <p>Don't</p>; // on 2.1.288\nconst b = <A>{/* 2.1.289 */}</A>;\n`,
  "non-ascii.ts": `const é = "ü"; // on 2.1.270\n`,
} as const;

type SourceName = keyof typeof SOURCES;

interface OxlintReport {
  diagnostics: {
    message: string;
    code: string;
    filename: string;
    labels: { span: { line: number; column: number } }[];
  }[];
}

let dir = "";

const reported = new Map<string, string[]>();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "no-frozen-facts-"));

  const config = join(dir, "oxlintrc.json");
  writeFileSync(
    config,
    JSON.stringify({
      jsPlugins: [{ name: "local", specifier: PLUGIN }],
      categories: { correctness: "off" },
      rules: { "local/no-frozen-facts": "error" },
    }),
  );

  for (const [name, source] of Object.entries(SOURCES)) writeFileSync(join(dir, name), source);

  const run = await $`bun x oxlint -c ${config} -f json ${dir}`.cwd(REPO_ROOT).nothrow().quiet();
  const report: OxlintReport = JSON.parse(run.stdout.toString());

  for (const diagnostic of report.diagnostics) {
    expect(diagnostic.code).toBe("local(no-frozen-facts)");
    const fact = /^`([^`]+)`/u.exec(diagnostic.message)?.[1];
    const { line, column } = diagnostic.labels[0]?.span ?? { line: 0, column: 0 };
    const name = diagnostic.filename.slice(dir.length + 1);
    reported.set(name, [...(reported.get(name) ?? []), `${line}:${column} ${fact}`]);
  }
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function facts(name: SourceName): string[] {
  return (reported.get(name) ?? []).toSorted();
}

describe("no-frozen-facts", () => {
  test("reports a line comment, at the fact's line and column", () => {
    expect(facts("line.ts")).toEqual(["2:29 2.1.270"]);
  });

  test("reports each fact of a doc block on the line it sits on", () => {
    expect(facts("doc-block.ts")).toEqual(["3:23 37004299897", "3:7 2.1.270"]);
  });

  test("reports a comment inside a template's interpolation", () => {
    expect(facts("interpolation.ts")).toEqual(["1:21 2.1.270"]);
  });

  test("reports comments after a division and a quoted quote", () => {
    expect(facts("after-quotes.js")).toEqual(["1:24 2.1.288", "2:22 2.1.289"]);
  });

  test("reports a JSX expression's comment", () => {
    expect(facts("jsx-comment.tsx")).toEqual(["1:31 2.1.288", "2:18 2.1.289"]);
  });

  test("points at the fact after a non-ASCII character", () => {
    // oxlint counts a column in UTF-8 bytes, two each for `é` and `ü`.
    expect(facts("non-ascii.ts")).toEqual(["1:24 2.1.270"]);
  });

  test("ignores string literals, regular expressions and JSX text", () => {
    expect(facts("strings.ts")).toEqual([]);
    expect(facts("regex.js")).toEqual([]);
    expect(facts("jsx-text.tsx")).toEqual([]);
  });

  test("ignores another tool's version and a Unix time", () => {
    expect(facts("other-numbers.ts")).toEqual([]);
  });
});
