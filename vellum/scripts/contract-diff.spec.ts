import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  contractDiff,
  functionChanges,
  functionsOf,
  titleChanges,
  titlesOf,
} from "./contract-diff.ts";

const javascript = (source: string): string =>
  new Bun.Transpiler({ loader: "tsx" }).transformSync(source);

describe("titlesOf", () => {
  test("reads a test's, a group's, a conditional test's and a keyed table's titles, in order", () => {
    const source = `
      describe("the table", () => {
        test("a row \\"quoted\\"", () => {});
        test.if(WINDOWS)("on Windows", () => {});
      });
      const ROWS = { "send: stale": ["a stale Send is refused", async () => {}] };
      for (const [title, run] of Object.values(ROWS)) test(title, run);
    `;

    expect(titlesOf(source)).toEqual([
      "the table",
      'a row "quoted"',
      "on Windows",
      "a stale Send is refused",
    ]);
  });

  test("reads no title inside a string, a template or a comment: a suite's fixtures are not its tests", () => {
    const source = [
      'const FIXTURE = `test("a fake", () => {});`;',
      'const OTHER = "describe(\\"another fake\\", () => {})";',
      '// test("a commented one", () => {});',
      'const TABLE = { row: ["a row no test reads", () => {}] };',
      'test("the real one", () => {});',
    ].join("\n");

    expect(titlesOf(source)).toEqual(["the real one"]);
  });
});

describe("titleChanges", () => {
  test("a title reworded pairs with its old words, one moved keeps them, the rest are new or gone", () => {
    const changes = titleChanges([
      {
        file: "a.spec.ts",
        before: ["a part imports its own folder, never another part", "kept", "moved"],
        after: ["a part imports its own folder and the review, never another part", "kept"],
      },
      { file: "b.spec.ts", before: ["gone for good"], after: ["moved", "brand new"] },
    ]);

    expect(changes).toEqual({
      added: [{ file: "b.spec.ts", title: "brand new" }],
      changed: [
        {
          from: { file: "a.spec.ts", title: "a part imports its own folder, never another part" },
          to: {
            file: "a.spec.ts",
            title: "a part imports its own folder and the review, never another part",
          },
        },
      ],
      moved: [
        { from: { file: "a.spec.ts", title: "moved" }, to: { file: "b.spec.ts", title: "moved" } },
      ],
      removed: [{ file: "b.spec.ts", title: "gone for good" }],
    });
  });
});

describe("functionsOf", () => {
  const BEFORE = `
    import { a } from "./a.ts";
    /** Doc. */
    export function add(x: number, y: number): number { return x + y; }
    const twice = (x: number): number => x * 2;
    class Queue { step(n: number) { return n + 1; } }
    const ROWS = [1, 2];
  `;

  test("a comment, a type, the layout or an import changed is no change", () => {
    const after = `
      import { a } from "./elsewhere/a.ts";
      // Another comment.
      export function add(x: number, y: number): number {
        return x + y;
      }
      const twice = (x: number): number => x * 2;
      class Queue { step(n: number) { return n + 1; } }
      const ROWS = [1, 2];
    `;

    expect(functionsOf(javascript(after))).toEqual(functionsOf(javascript(BEFORE)));
  });

  test("a function moved into another, its lines indented further, keeps its body", () => {
    const f = "function f(n: number) {\n  if (n) {\n    return n;\n  }\n  return 0;\n}";
    const alone = functionsOf(javascript(f));
    const inside = `function createStore() {\n  ${f.replaceAll("\n", "\n  ")}\n  return { f };\n}`;
    const nested = functionsOf(javascript(inside));

    expect(nested.functions.get("f")).toBe(alone.functions.get("f"));
  });

  test("a body changed is, by the function's name, a method's included; code outside every function is the file's", () => {
    const before = functionsOf(javascript(BEFORE));

    const after = functionsOf(
      javascript(
        BEFORE.replace("x * 2", "x * 3").replace("n + 1", "n + 2").replace("[1, 2]", "[1]"),
      ),
    );

    expect([...after.functions.keys()]).toEqual(["add", "twice", "step"]);
    expect(
      [...after.functions].flatMap(([name, body]) =>
        before.functions.get(name) === body ? [] : [name],
      ),
    ).toEqual(["twice", "step"]);
    expect(after.outside).not.toBe(before.outside);
  });
});

describe("functionChanges", () => {
  test("a function gone from one file and new in another with the same body moved; a body changed is named by its file", () => {
    const one = functionsOf(
      javascript("function kept() { return 1; }\nfunction moving() { return 2; }"),
    );

    const oneAfter = functionsOf(javascript("function kept() { return 3; }"));
    const other = functionsOf(javascript("function moving() { return 2; }"));

    expect(
      functionChanges([
        { file: "one.ts", before: one, after: oneAfter },
        { file: "other.ts", before: functionsOf(""), after: other },
      ]),
    ).toEqual({
      byFile: [{ file: "one.ts", changed: ["kept"], added: [], removed: [], outside: false }],
      moved: [{ name: "moving", from: "one.ts", to: "other.ts" }],
    });
  });
});

/** A repository of its own under the temp directory, and a commit of the files given, answering its SHA. */
type Repository = {
  readonly root: string;
  readonly commit: (files: Record<string, string>) => string;
};

/** Holds a plugin at `plug/`, as this repository holds `vellum/`. */
function repository(): Repository {
  const root = mkdtempSync(join(tmpdir(), "contract-diff-"));

  const git = (...args: string[]): string => {
    const run = Bun.spawnSync(
      ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );

    if (run.exitCode !== 0) throw new Error(run.stderr.toString());

    return run.stdout.toString().trim();
  };

  git("init", "-q");

  return {
    root,
    commit: (files) => {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      }

      git("add", "-A");
      git("commit", "-q", "-m", "step");

      return git("rev-parse", "HEAD");
    },
  };
}

describe("contractDiff", () => {
  test("prints the contracts' diff, the rules, the titles, the functions and the suites, in that order", () => {
    const { root, commit } = repository();

    const base = commit({
      "plug/src/steps/x/contract.ts": 'export const SLICE = { id: "x" };\n',
      "plug/src/__snapshots__/table.spec.ts.snap": "ask · owned by x\n  1. x/held · refuses\n",
      "plug/src/steps/x/x.spec.ts": 'test("asks once", () => {});\n',
      "plug/src/steps/x/x.ts": "export function ask(n: number) { return n; }\n",
    });

    const head = commit({
      "plug/src/steps/x/contract.ts": 'export const SLICE = { id: "x", events: {} };\n',
      "plug/src/__snapshots__/table.spec.ts.snap": "ask · owned by x\n  1. x/held · refuses 409\n",
      "plug/src/steps/x/x.spec.ts": 'test("asks once, then waits", () => {});\n',
      "plug/src/steps/x/x.ts": "export function ask(n: number) { return n + 1; }\n",
    });

    const report = contractDiff(`${base}..${head}`, join(root, "plug"), false);

    expect(report.split("\n").filter((line) => line.startsWith("## "))).toEqual([
      "## Contracts",
      "## Rules (`table.spec.ts.snap`)",
      "## Test titles",
      "## Function bodies changed outside the contracts",
      "## Boundary and walk suites, on the working tree",
    ]);
    expect(report).toContain('+export const SLICE = { id: "x", events: {} };');
    expect(report).toContain("-  1. x/held · refuses\n+  1. x/held · refuses 409");
    expect(report).toContain("- asks once\n  → asks once, then waits (`src/steps/x/x.spec.ts`)");
    expect(report).toContain("- `src/steps/x/x.ts`: changed `ask`");
    expect(report).toContain("Not run.");
  });

  test("says so when no contract and no rule changed", () => {
    const { root, commit } = repository();
    const base = commit({ "plug/src/a.ts": "export const A = 1;\n" });
    const head = commit({ "plug/src/a.ts": "export const A = 2;\n" });

    const report = contractDiff(`${base}..${head}`, join(root, "plug"), false);

    expect(report).toContain("## Contracts\n\nNo contract changed.");
    expect(report).toContain("## Rules (`table.spec.ts.snap`)\n\nNo rule changed.");
    expect(report).toContain("- `src/a.ts`: and code outside its functions");
  });
});
