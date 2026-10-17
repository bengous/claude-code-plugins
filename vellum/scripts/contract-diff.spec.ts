import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  batchTexts,
  caseChanges,
  contractDiff,
  functionChanges,
  functionsOf,
  objectsRead,
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

describe("objectsRead", () => {
  test("names the texts the sections read alone, and only the sides a change has", () => {
    const changes = [
      { status: "M", from: "plug/src/a.ts", to: "plug/src/a.ts" },
      { status: "M", from: "plug/bun.lock", to: "plug/bun.lock" },
      { status: "A", from: "plug/e2e/shot.png", to: "plug/e2e/shot.png" },
      { status: "A", from: "plug/skills/start/SKILL.md", to: "plug/skills/start/SKILL.md" },
      { status: "D", from: "plug/src/gone.spec.ts", to: "plug/src/gone.spec.ts" },
    ] as const;

    expect(objectsRead(changes, "b", "h", "plug")).toEqual([
      "b:plug/src/a.ts",
      "h:plug/src/a.ts",
      "h:plug/skills/start/SKILL.md",
      "b:plug/src/gone.spec.ts",
    ]);
  });
});

describe("batchTexts", () => {
  const SHA = "f".repeat(40);
  const blob = (text: string): string => `${SHA} blob ${Buffer.byteLength(text)}\n${text}\n`;

  test("reads each blob by its size in bytes; a name git reports missing has no text", () => {
    const output = Buffer.from(`${blob("é\nline")}b:gone.ts missing\n${blob("two")}`);

    expect(batchTexts(["b:a.ts", "b:gone.ts", "h:a.ts"], output)).toEqual(
      new Map([
        ["b:a.ts", "é\nline"],
        ["h:a.ts", "two"],
      ]),
    );
  });

  test("an ambiguous name throws, never shifting the texts after it", () => {
    const output = Buffer.from(`b:a.ts ambiguous\n${blob("two")}`);

    expect(() => batchTexts(["b:a.ts", "h:a.ts"], output)).toThrow("b:a.ts ambiguous");
  });

  test("an object that is no blob throws, naming its type", () => {
    const output = Buffer.from(`${SHA} tree 0\n\n`);

    expect(() => batchTexts(["b:src"], output)).toThrow("tree");
  });
});

/** Each file a commit sets, by its path from the repository's root, and its text. */
type Files = Readonly<Record<string, string>>;

/** A repository of its own under the temp directory, its last commit checked out, and each commit's SHA. */
type Repository<Commits extends readonly Files[]> = {
  readonly root: string;
  readonly shas: { readonly [Index in keyof Commits]: string };
};

/**
 * Runs `git` in `root`, `input` on its stdin, and answers its stdout trimmed. `core.autocrlf` is
 * off whatever the machine's config says, a Windows install's may turn it on: the checkout holds
 * the blobs' bytes.
 */
function git(root: string, args: readonly string[], input = ""): string {
  const run = Bun.spawnSync(["git", "-c", "core.autocrlf=false", ...args], {
    cwd: root,
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });

  if (run.exitCode !== 0) throw new Error(run.stderr.toString());

  return run.stdout.toString().trim();
}

/**
 * Holds a plugin at `plug/`, as this repository holds `vellum/`: each commit sets its files over the
 * one before. `git fast-import` writes them all, a process for the whole history: a process per
 * `git` command is what a spec pays most for on Windows.
 */
function repository<const Commits extends readonly Files[]>(
  ...commits: Commits
): Repository<Commits> {
  const root = mkdtempSync(join(tmpdir(), "contract-diff-"));

  const stream = commits.flatMap((files, index) => [
    "commit refs/heads/main",
    `mark :${index + 1}`,
    "committer t <t@t> 0 +0000",
    "data 4",
    "step",
    ...Object.entries(files).flatMap(([path, text]) => [
      `M 100644 inline ${path}`,
      `data ${Buffer.byteLength(text)}`,
      text,
    ]),
  ]);

  const marks = commits.map((_, index) => `get-mark :${index + 1}`);

  git(root, ["init", "-q", "--initial-branch=main"]);

  const shas = git(
    root,
    ["-c", "fastimport.unpackLimit=0", "fast-import", "--quiet"],
    `${[...stream, ...marks].join("\n")}\n`,
  ).split("\n");

  git(root, ["reset", "-q", "--hard"]);

  // SAFETY: fast-import answers each `get-mark` with its commit's SHA on a line, in the order asked.
  return { root, shas: shas as Repository<Commits>["shas"] };
}

/**
 * Writes into the repository a tree whose SHA begins as `commit`'s does, and answers that shared
 * prefix: a name git reads as the commit where only a commit fits, ambiguous where a tree fits too.
 */
function treeSharingPrefix(root: string, commit: string): string {
  const prefix = commit.slice(0, 4);
  const empty = Buffer.from("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", "hex");

  for (let n = 0; ; n += 1) {
    const entry = Buffer.concat([Buffer.from(`100644 f${n}\0`), empty]);
    const tree = Buffer.concat([Buffer.from(`tree ${entry.length}\0`), entry]);

    if (Bun.CryptoHasher.hash("sha1", tree, "hex").startsWith(prefix)) {
      git(root, ["mktree", "--missing"], `100644 blob ${empty.toString("hex")}\tf${n}\n`);

      return prefix;
    }
  }
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

// Each test writes a repository and runs `git` seven to nine times, the suites' one a `tar` and a
// `bun test` besides. On windows-latest, `bun test --parallel vellum`, bun 1.4.3, a job's first
// pass: up to 2.6 s over 10 passes of run 39027611581, 2026-10-17. 15 s is about six times that.
describe("contractDiff", () => {
  setDefaultTimeout(15_000);

  test("prints the contracts' diff, the rules, the titles, the functions and the suites, in that order", () => {
    const {
      root,
      shas: [base, head],
    } = repository(
      {
        "plug/src/steps/x/contract.ts": 'export const SLICE = { id: "x" };\n',
        "plug/src/__snapshots__/table.spec.ts.snap": "ask · owned by x\n  1. x/held · refuses\n",
        "plug/src/steps/x/x.spec.ts": 'test("asks once", () => {});\n',
        "plug/src/steps/x/x.ts": "export function ask(n: number) { return n; }\n",
      },
      {
        "plug/src/steps/x/contract.ts": 'export const SLICE = { id: "x", events: {} };\n',
        "plug/src/__snapshots__/table.spec.ts.snap":
          "ask · owned by x\n  1. x/held · refuses 409\n",
        "plug/src/steps/x/x.spec.ts": 'test("asks once, then waits", () => {});\n',
        "plug/src/steps/x/x.ts": "export function ask(n: number) { return n + 1; }\n",
      },
    );

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

  test("finds the plugin in a repository reached by another spelling of its path, a link or a short name", () => {
    const {
      root,
      shas: [base, head],
    } = repository(
      { "plug/src/steps/x/contract.ts": 'export const SLICE = { id: "x" };\n' },
      { "plug/src/steps/x/contract.ts": 'export const SLICE = { id: "y" };\n' },
    );

    const alias = join(mkdtempSync(join(tmpdir(), "contract-diff-alias-")), "repo");
    symlinkSync(root, alias);

    const report = contractDiff(`${base}..${head}`, join(alias, "plug"), false);

    expect(report).toContain('+export const SLICE = { id: "y" };');
  });

  test("runs the boundary and walk suites at the range's head, not on the tree checked out", () => {
    const {
      root,
      shas: [base, head],
    } = repository(
      { "plug/src/boundaries.spec.ts": suite(["one"]) },
      { "plug/src/boundaries.spec.ts": suite(["one", "two"]) },
      { "plug/src/boundaries.spec.ts": suite(["one", "two", "three"]) },
    );

    const report = contractDiff(`${base}..${head}`, join(root, "plug"));
    const short = head.slice(0, 7);

    expect(report).toContain(
      `- boundaries (\`src/boundaries.spec.ts\`) at \`${short}\`: green, 2 pass, 0 fail`,
    );
    expect(report).toContain(`- walk: no \`src/workflow.spec.ts\` at \`${short}\``);
  });

  test("shows what Claude reads, a tool's description and a skill, word by word, after the contracts", () => {
    const {
      root,
      shas: [base, head],
    } = repository(
      {
        "plug/src/steps/x/hooks.ts": ask("Ask one round of the grill"),
        "plug/skills/start/SKILL.md": "Propose the next step, then wait.\n",
      },
      {
        "plug/src/steps/x/hooks.ts": ask("Ask one round of the grill and wait"),
        "plug/skills/start/SKILL.md": "Propose the next step, then wait for the pick.\n",
      },
    );

    const report = contractDiff(`${base}..${head}`, join(root, "plug"), false);

    expect(report).toContain(
      "- `ASK` (`src/steps/x/hooks.ts`): Ask one round of the grill{+ and wait+}",
    );
    expect(report).toContain(
      "- `skills/start/SKILL.md`: Propose the next step, then wait{+ for the pick+}.",
    );
  });

  test("lists the cases added to a test's table under its title, the title kept", () => {
    const {
      root,
      shas: [base, head],
    } = repository(
      { "plug/src/x.spec.ts": table("{ id: null }") },
      { "plug/src/x.spec.ts": table('{ id: null }, { id: "p1", note: " " }') },
    );

    const report = contractDiff(`${base}..${head}`, join(root, "plug"), false);

    expect(report).toContain(
      'Cases added, the title kept (1):\n- refuses a bad body (`src/x.spec.ts`):\n  - `{ id: "p1", note: " " }`',
    );
  });

  test("a contract whose comments only moved shows no diff, and says so", () => {
    const code = 'import { a } from "./a.ts";\nexport const SLICE = { id: "x" };\n';

    const {
      root,
      shas: [base, head],
    } = repository(
      { "plug/src/steps/x/contract.ts": `/** The x step. */\n${code}` },
      { "plug/src/steps/x/contract.ts": code.replace("\n", "\n\n/** The x step. */\n") },
    );

    const report = contractDiff(`${base}..${head}`, join(root, "plug"), false);

    expect(report).toContain("## Contracts\n\nOnly comments moved in `src/steps/x/contract.ts`.");
    expect(report).not.toContain("```diff");
  });

  test("says once, under its title, that a contract declares fields, not their values", () => {
    const {
      root,
      shas: [base, head],
    } = repository(
      { "plug/src/a.ts": "export const A = 1;\n" },
      { "plug/src/a.ts": "export const A = 2;\n" },
    );

    const report = contractDiff(`${base}..${head}`, join(root, "plug"), false);

    expect(report.split("\n").slice(1, 4)).toEqual([
      "",
      "A contract declares fields, not their values: a new value of a declared field (a `move` an event carries) shows in no section below.",
      "",
    ]);
  });

  test("says so when no contract and no rule changed", () => {
    const {
      root,
      shas: [base, head],
    } = repository(
      { "plug/src/a.ts": "export const A = 1;\n" },
      { "plug/src/a.ts": "export const A = 2;\n" },
    );

    const report = contractDiff(`${base}..${head}`, join(root, "plug"), false);

    expect(report).toContain("## Contracts\n\nNo contract changed.");
    expect(report).toContain("## Rules (`table.spec.ts.snap`)\n\nNo rule changed.");
    expect(report).toContain("- `src/a.ts`: and code outside its functions");
  });

  test("reads the commit a short base names, though a tree's SHA begins the same", () => {
    const {
      root,
      shas: [base, head],
    } = repository(
      { "plug/src/steps/x/contract.ts": 'export const SLICE = { id: "x" };\n' },
      { "plug/src/steps/x/contract.ts": 'export const SLICE = { id: "y" };\n' },
    );

    const short = treeSharingPrefix(root, base);
    const report = contractDiff(`${short}..${head}`, join(root, "plug"), false);

    expect(report).toContain('+export const SLICE = { id: "y" };');
  });
});
