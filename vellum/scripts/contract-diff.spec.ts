import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  caseChanges,
  contractDiff,
  functionChanges,
  functionsOf,
  titleChanges,
  titlesOf,
  wordChanges,
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

describe("caseChanges", () => {
  const BEFORE = [
    'test("refuses a bad body", () => {',
    '  const wrong = [{ id: "" }, { id: null }];',
    "  for (const body of wrong) expect(parse(body)).toBeNull();",
    "});",
    'test("answers once", () => { expect(answer()).toBe(1); });',
  ].join("\n");

  test("rows added to a test's table are its cases added; a body changed otherwise is cases changed", () => {
    const after = BEFORE.replace("{ id: null }]", "{ id: null }, { id: 3 }]").replace(
      "toBe(1)",
      "toBe(2)",
    );

    expect(caseChanges(BEFORE, after)).toEqual([
      { title: "refuses a bad body", added: ["{ id: 3 }"], removed: [], code: false },
      { title: "answers once", added: [], removed: [], code: true },
    ]);
  });

  test("two tests of one title in a suite are told apart by their order: neither changed", () => {
    const twice =
      'test("is a bad request", () => { a(); });\ntest("is a bad request", () => { b(); });\n';

    expect(caseChanges(twice, twice)).toEqual([]);
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

  test("a call whose name begins with `function` declares nothing: no `At`, no `sOf`", () => {
    const found = functionsOf(javascript("const n = functionAt(1) + functionsOf(2);"));

    expect([...found.functions.keys()]).toEqual([]);
  });
});

describe("wordChanges", () => {
  test("a change is one run: what the two texts share inside it, a stop or a space, does not split it", () => {
    const changed = wordChanges(
      "for their own words. Take the step",
      'for their own words, "Declined." or none. Take the step',
    );

    expect(changed).toContain('{+, "Declined." or none.');
    expect(changed).not.toMatch(/\+\}.{0,2}\{\+|-\].{0,2}\[-/u);
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
      movedChanged: [],
    });
  });

  test("a function moved to another file and changed there is one entry, not gone here and new there", () => {
    const before = functionsOf(javascript("function statusOf(n: number) { return n; }"));
    const after = functionsOf(javascript("function statusOf(n: number) { return n + 1; }"));

    expect(
      functionChanges([
        { file: "slice.ts", before, after: functionsOf("") },
        { file: "workflow.ts", before: functionsOf(""), after },
      ]),
    ).toEqual({
      byFile: [],
      moved: [],
      movedChanged: [{ name: "statusOf", from: "slice.ts", to: "workflow.ts" }],
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

/** A suite holding one passing test per title. */
function suite(tests: readonly string[]): string {
  const lines = tests.map((one) => `test("${one}", () => {});`);

  return `import { test } from "bun:test";\n${lines.join("\n")}\n`;
}

/** A hooks module whose tool `ASK` Claude reads as `text`. */
function ask(text: string): string {
  return `const ASK = { description: "${text}" };\n`;
}

/** A suite whose one test refuses each body of its table `wrong`, whose rows are `rows`. */
function table(rows: string): string {
  return `test("refuses a bad body", () => {\n  const wrong = [${rows}];\n});\n`;
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
      "## What Claude reads",
      "## Rules (`table.spec.ts.snap`)",
      "## Test titles",
      "## Function bodies changed outside the contracts",
      "## Boundary and walk suites, at the range's head",
    ]);
    expect(report).toContain('+export const SLICE = { id: "x", events: {} };');
    expect(report).toContain("-  1. x/held · refuses\n+  1. x/held · refuses 409");
    expect(report).toContain("- asks once\n  → asks once, then waits (`src/steps/x/x.spec.ts`)");
    expect(report).toContain("- `src/steps/x/x.ts`: changed `ask`");
    expect(report).toContain("Not run.");
  });

  test("runs the boundary and walk suites at the range's head, not on the tree checked out", () => {
    const { root, commit } = repository();
    const base = commit({ "plug/src/boundaries.spec.ts": suite(["one"]) });
    const head = commit({ "plug/src/boundaries.spec.ts": suite(["one", "two"]) });
    commit({ "plug/src/boundaries.spec.ts": suite(["one", "two", "three"]) });

    const report = contractDiff(`${base}..${head}`, join(root, "plug"));
    const short = head.slice(0, 7);

    expect(report).toContain(
      `- boundaries (\`src/boundaries.spec.ts\`) at \`${short}\`: green, 2 pass, 0 fail`,
    );
    expect(report).toContain(`- walk: no \`src/workflow.spec.ts\` at \`${short}\``);
  });

  test("shows what Claude reads, a tool's description and a skill, word by word, after the contracts", () => {
    const { root, commit } = repository();

    const base = commit({
      "plug/src/steps/x/hooks.ts": ask("Ask one round of the grill"),
      "plug/skills/start/SKILL.md": "Propose the next step, then wait.\n",
    });

    const head = commit({
      "plug/src/steps/x/hooks.ts": ask("Ask one round of the grill and wait"),
      "plug/skills/start/SKILL.md": "Propose the next step, then wait for the pick.\n",
    });

    const report = contractDiff(`${base}..${head}`, join(root, "plug"), false);

    expect(report).toContain(
      "- `ASK` (`src/steps/x/hooks.ts`): Ask one round of the grill{+ and wait+}",
    );
    expect(report).toContain(
      "- `skills/start/SKILL.md`: Propose the next step, then wait{+ for the pick+}.",
    );
  });

  test("lists the cases added to a test's table under its title, the title kept", () => {
    const { root, commit } = repository();
    const base = commit({ "plug/src/x.spec.ts": table("{ id: null }") });
    const head = commit({ "plug/src/x.spec.ts": table('{ id: null }, { id: "p1", note: " " }') });

    const report = contractDiff(`${base}..${head}`, join(root, "plug"), false);

    expect(report).toContain(
      'Cases added, the title kept (1):\n- refuses a bad body (`src/x.spec.ts`):\n  - `{ id: "p1", note: " " }`',
    );
  });

  test("a contract whose comments only moved shows no diff, and says so", () => {
    const { root, commit } = repository();
    const code = 'import { a } from "./a.ts";\nexport const SLICE = { id: "x" };\n';
    const base = commit({ "plug/src/steps/x/contract.ts": `/** The x step. */\n${code}` });

    const head = commit({
      "plug/src/steps/x/contract.ts": code.replace("\n", "\n\n/** The x step. */\n"),
    });

    const report = contractDiff(`${base}..${head}`, join(root, "plug"), false);

    expect(report).toContain("## Contracts\n\nOnly comments moved in `src/steps/x/contract.ts`.");
    expect(report).not.toContain("```diff");
  });

  test("says once, under its title, that a contract declares fields, not their values", () => {
    const { root, commit } = repository();
    const base = commit({ "plug/src/a.ts": "export const A = 1;\n" });
    const head = commit({ "plug/src/a.ts": "export const A = 2;\n" });

    const report = contractDiff(`${base}..${head}`, join(root, "plug"), false);

    expect(report.split("\n").slice(1, 4)).toEqual([
      "",
      "A contract declares fields, not their values: a new value of a declared field (a `move` an event carries) shows in no section below.",
      "",
    ]);
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
