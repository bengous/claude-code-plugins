import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parse } from "yaml";

import config from "../stryker.config.ts";
import {
  baseLineOf,
  changedRanges,
  changeSince,
  describeSurvivor,
  githubOutput,
  type Hunk,
  hunksOf,
  type LineRange,
  moduleVerdict,
  modulesOf,
  type Mutant,
  parseArgs,
  rangeLabel,
  rangeOf,
  runOptions,
  snapshotAt,
  testFileOf,
  undetected,
} from "./mutation.ts";

const NO_ACTIONS = {};

describe("changedRanges", () => {
  test("the lines each file gains or rewrites, a one-line hunk included", () => {
    const diff = [
      "diff --git a/scripts/changelog.ts b/scripts/changelog.ts",
      "--- a/scripts/changelog.ts",
      "+++ b/scripts/changelog.ts",
      "@@ -10,2 +10,3 @@ export function semverOf(",
      "-old",
      "+new",
      "@@ -40 +41 @@",
      "-old",
      "+// @@ -1 +99 @@",
      "@@ -100,12 +101,12 @@",
      "diff --git a/agent-hooks/config.ts b/agent-hooks/config.ts",
      "--- a/agent-hooks/config.ts",
      "+++ b/agent-hooks/config.ts",
      "@@ -7,0 +8,2 @@",
      "+added",
    ].join("\n");

    expect(changedRanges(diff)).toEqual([
      { file: "scripts/changelog.ts", start: 10, end: 12 },
      { file: "scripts/changelog.ts", start: 41, end: 41 },
      { file: "scripts/changelog.ts", start: 101, end: 112 },
      { file: "agent-hooks/config.ts", start: 8, end: 9 },
    ]);
  });

  test("an added line that reads as a file header stays in its hunk's file", () => {
    const diff = [
      "diff --git a/agent-hooks/config.ts b/agent-hooks/config.ts",
      "--- a/agent-hooks/config.ts",
      "+++ b/agent-hooks/config.ts",
      "@@ -3 +3,2 @@",
      "--- a/removed.ts",
      "+++ b/added.ts",
      "+// the line above was added as `++ b/added.ts`",
      "@@ -9 +10 @@",
      "+later",
    ].join("\n");

    expect(changedRanges(diff)).toEqual([
      { file: "agent-hooks/config.ts", start: 3, end: 4 },
      { file: "agent-hooks/config.ts", start: 10, end: 10 },
    ]);
  });

  test("a hunk that only deletes changes the lines on either side of where it cut", () => {
    const diff = [
      "diff --git a/agent-hooks/config.ts b/agent-hooks/config.ts",
      "--- a/agent-hooks/config.ts",
      "+++ b/agent-hooks/config.ts",
      "@@ -1,2 +0,0 @@",
      "-gone",
      "-gone",
      "@@ -10,2 +9,0 @@",
      "-gone",
      "-gone",
    ].join("\n");

    expect(changedRanges(diff)).toEqual([
      { file: "agent-hooks/config.ts", start: 1, end: 1 },
      { file: "agent-hooks/config.ts", start: 9, end: 10 },
    ]);
  });

  test("a deleted file leaves no line, not even in the file before it", () => {
    const diff = [
      "diff --git a/agent-hooks/config.ts b/agent-hooks/config.ts",
      "--- a/agent-hooks/config.ts",
      "+++ b/agent-hooks/config.ts",
      "@@ -3 +3 @@",
      "+kept",
      "diff --git a/agent-hooks/config.test.ts b/agent-hooks/config.test.ts",
      "deleted file mode 100644",
      "--- a/agent-hooks/config.test.ts",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
      "-gone",
    ].join("\n");

    expect(changedRanges(diff)).toEqual([{ file: "agent-hooks/config.ts", start: 3, end: 3 }]);
  });
});

test("a range reads file:start-end", () => {
  expect(rangeLabel({ file: "agent-hooks/config.ts", start: 8, end: 9 })).toBe(
    "agent-hooks/config.ts:8-9",
  );
});

const hunk = (
  file: string,
  oldStart: number,
  oldCount: number,
  newStart: number,
  newCount: number,
): Hunk => ({
  file,
  oldStart,
  oldCount,
  newStart,
  newCount,
});

test("a hunk keeps both sides of its header", () => {
  const diff = [
    "diff --git a/f.ts b/f.ts",
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -3 +3,2 @@ l2",
    "-l3",
    "+NEW3a",
    "+NEW3b",
    "@@ -10,2 +10,0 @@ l9",
    "-l10",
    "-l11",
  ].join("\n");

  expect(hunksOf(diff)).toEqual([hunk("f.ts", 3, 1, 3, 2), hunk("f.ts", 10, 2, 10, 0)]);
});

test("a line the change left alone has its line at the base; a changed one has none", () => {
  // l1..l12 became l1 l2 NEW3a NEW3b l4..l9 l12: line 3 rewritten as two, lines 10 and 11 deleted.
  const hunks = [hunk("f.ts", 3, 1, 3, 2), hunk("f.ts", 10, 2, 10, 0)];

  expect([1, 2, 3, 4, 5, 10, 11].map((line) => baseLineOf(line, hunks))).toEqual([
    1,
    2,
    null,
    null,
    4,
    9,
    12,
  ]);
});

test("the listed modules a change reaches through their own lines or their tests, each once", () => {
  const listed = ["a.ts", "b.ts", "c.ts"];

  expect(
    modulesOf(
      [hunk("b.test.ts", 1, 1, 1, 1), hunk("a.ts", 3, 0, 4, 1), hunk("b.ts", 9, 1, 9, 1)],
      listed,
    ),
  ).toEqual(["b.ts", "a.ts"]);
});

test("CI's output says whether a listed module or its tests changed", () => {
  expect(githubOutput([hunk("a.test.ts", 1, 1, 1, 1)])).toBe("mutate=true\n");
  expect(githubOutput([])).toBe("mutate=false\n");
});

test("a pass mutates one module whole, against its own tests alone", () => {
  expect(runOptions("agent-hooks/config.ts")).toEqual({
    mutate: ["agent-hooks/config.ts"],
    commandRunner: { command: "bun test ./agent-hooks/config.test.ts" },
  });
});

describe("parseArgs", () => {
  test("a command, with a base or without", () => {
    expect(parseArgs(["run"])).toEqual({ command: "run", base: undefined });
    expect(parseArgs(["github-output", "--base", "HEAD~2"])).toEqual({
      command: "github-output",
      base: "HEAD~2",
    });
  });

  test("refuses an unknown command, a flag without its ref, or anything more", () => {
    expect(parseArgs([])).toBeNull();
    expect(parseArgs(["print"])).toBeNull();
    expect(parseArgs(["run", "--base"])).toBeNull();
    expect(parseArgs(["run", "--ref", "HEAD"])).toBeNull();
    expect(parseArgs(["run", "--base", "HEAD", "extra"])).toBeNull();
  });
});

describe("testFileOf", () => {
  test("is the .test.ts beside the module", () => {
    expect(testFileOf("scripts/changelog.ts")).toBe("scripts/changelog.test.ts");
  });

  test("refuses a module that is not TypeScript", () => {
    expect(() => testFileOf("scripts/run.sh")).toThrow("must be a .ts file");
  });
});

test("every listed module has its .test.ts", async () => {
  const root = join(import.meta.dir, "..");
  const missing = [];

  for (const module of config.mutate) {
    if (!(await Bun.file(join(root, testFileOf(module))).exists())) missing.push(module);
  }

  expect(missing).toEqual([]);
});

function mutant(fields: Partial<Mutant>): Mutant {
  return {
    fileName: "/repo/agent-hooks/config.ts",
    location: { start: { line: 2, column: 7 }, end: { line: 2, column: 32 } },
    mutatorName: "ConditionalExpression",
    replacement: "false",
    status: "Survived",
    ...fields,
  };
}

describe("describeSurvivor", () => {
  const source = [
    "function seconds(value: unknown): void {",
    '  if (typeof value !== "number" || value <= 0) {',
    "    throw new Error();",
    "  }",
    "}",
  ].join("\n");

  test("names the file, the line and column, the mutator, the code and its replacement", () => {
    expect(describeSurvivor("agent-hooks/config.ts", source, mutant({}))).toBe(
      'agent-hooks/config.ts:2:7 Survived ConditionalExpression: typeof value !== "number" => false',
    );
  });

  test("shows a mutant over several lines by its first, on one line", () => {
    const block = mutant({
      location: { start: { line: 2, column: 47 }, end: { line: 4, column: 4 } },
      mutatorName: "BlockStatement",
      replacement: "{\n    return;\n  }",
    });

    expect(describeSurvivor("agent-hooks/config.ts", source, block)).toBe(
      "agent-hooks/config.ts:2:47 Survived BlockStatement: {… => { return; }",
    );
  });
});

describe("undetected", () => {
  test("keeps the survivors and the mutants no test reached", () => {
    const results = (["Killed", "Survived", "Timeout", "NoCoverage", "CompileError"] as const).map(
      (status) => mutant({ status }),
    );

    expect(undetected(results).map((result) => result.status)).toEqual(["Survived", "NoCoverage"]);
  });

  test("orders them by file, line and column", () => {
    const at = (fileName: string, line: number, column: number): Mutant =>
      mutant({
        fileName,
        location: { start: { line, column }, end: { line, column: column + 1 } },
      });

    const found = undetected([
      at("/b.ts", 1, 1),
      at("/a.ts", 9, 4),
      at("/a.ts", 9, 2),
      at("/a.ts", 3, 8),
    ]).map(
      ({ fileName, location }) => `${fileName}:${location.start.line}:${location.start.column}`,
    );

    expect(found).toEqual(["/a.ts:3:8", "/a.ts:9:2", "/a.ts:9:4", "/b.ts:1:1"]);
  });
});

describe("the changed lines a survivor meets", () => {
  const source = Array.from({ length: 30 }, (_, index) => `line ${index + 1};`).join("\n");

  const at = (start: number, end: number, status: Mutant["status"] = "Survived"): Mutant =>
    mutant({
      location: { start: { line: start, column: 1 }, end: { line: end, column: 2 } },
      status,
    });

  const failing = (head: readonly Mutant[], hunks: readonly Hunk[]): number =>
    moduleVerdict({ module: "x/mod.ts", source, head, base: null, hunks }).failures.length;

  test("one spanning past a changed line meets it; a killed one never fails", () => {
    const changed = [hunk("x/mod.ts", 15, 1, 15, 1)];

    expect(
      failing([at(10, 20), at(15, 15), at(14, 14), at(16, 30), at(15, 15, "Killed")], changed),
    ).toBe(2);
  });

  test("any of several ranges counts", () => {
    const changed = [hunk("x/mod.ts", 3, 1, 3, 1), hunk("x/mod.ts", 9, 1, 9, 1)];

    expect(failing([at(3, 3), at(9, 9), at(6, 6)], changed)).toBe(2);
  });

  test("a range's either edge counts", () => {
    const changed = [hunk("x/mod.ts", 5, 3, 5, 3)];

    expect(failing([at(1, 5), at(7, 9), at(1, 4), at(8, 9)], changed)).toBe(2);
  });
});

describe("moduleVerdict", () => {
  const source = ["const a = 1;", "if (a > 0) {", "  run();", "}", "const b = a + 1;"].join("\n");
  const changed = [hunk("x/mod.ts", 2, 1, 2, 1)];

  const results = [
    mutant({
      fileName: "/repo/x/mod.ts",
      location: { start: { line: 2, column: 5 }, end: { line: 2, column: 10 } },
      mutatorName: "EqualityOperator",
      replacement: "a >= 0",
    }),
    mutant({
      fileName: "/repo/x/mod.ts",
      location: { start: { line: 5, column: 11 }, end: { line: 5, column: 16 } },
      mutatorName: "ArithmeticOperator",
      replacement: "a - 1",
    }),
    mutant({ status: "Killed" }),
    mutant({ status: "Ignored", mutatorName: "StringLiteral" }),
  ];

  test("names each survivor on a changed line, and counts the others apart", () => {
    expect(
      moduleVerdict({ module: "x/mod.ts", source, head: results, base: null, hunks: changed }),
    ).toEqual({
      failures: ["x/mod.ts:2:5 Survived EqualityOperator: a > 0 => a >= 0"],
      summary:
        "mutation: x/mod.ts: 3 mutant(s) tested, 1 undetected on the changed lines, 1 elsewhere, outside this change",
    });
  });

  test("has no failure when only lines outside the change keep a survivor", () => {
    const elsewhere = [hunk("x/mod.ts", 3, 1, 3, 1)];

    expect(
      moduleVerdict({ module: "x/mod.ts", source, head: results, base: null, hunks: elsewhere })
        .failures,
    ).toEqual([]);
  });

  test("with the tests changed, fails on a mutant the base's tests killed and the head's do not", () => {
    // The tests alone changed: the source, so every mutant, is the same at the base.
    const atBase = results.map((found) => ({ ...found, status: "Killed" as const }));

    expect(
      moduleVerdict({ module: "x/mod.ts", source, head: results, base: atBase, hunks: [] }),
    ).toEqual({
      failures: [
        "x/mod.ts:2:5 Survived EqualityOperator: a > 0 => a >= 0 (killed at the base)",
        "x/mod.ts:5:11 Survived ArithmeticOperator: a + 1 => a - 1 (killed at the base)",
      ],
      summary:
        "mutation: x/mod.ts: 3 mutant(s) tested, 0 undetected on the changed lines, 2 killed at the base and undetected now, 0 elsewhere, outside this change",
    });
  });

  test("matches a mutant to its base by the line it had there, and counts it once", () => {
    // One line inserted above line 5 at the head: its mutant sat on line 4 at the base.
    const inserted = [hunk("x/mod.ts", 1, 0, 2, 1)];

    const atBase = [
      mutant({
        fileName: "/base/x/mod.ts",
        location: { start: { line: 4, column: 11 }, end: { line: 4, column: 16 } },
        mutatorName: "ArithmeticOperator",
        replacement: "a - 1",
        status: "Killed",
      }),
      mutant({
        fileName: "/base/x/mod.ts",
        location: { start: { line: 5, column: 11 }, end: { line: 5, column: 16 } },
        mutatorName: "ArithmeticOperator",
        replacement: "a - 1",
        status: "Survived",
      }),
    ];

    expect(
      moduleVerdict({ module: "x/mod.ts", source, head: results, base: atBase, hunks: inserted })
        .failures,
    ).toEqual([
      "x/mod.ts:2:5 Survived EqualityOperator: a > 0 => a >= 0",
      "x/mod.ts:5:11 Survived ArithmeticOperator: a + 1 => a - 1 (killed at the base)",
    ]);
  });
});

async function linesSince(...args: Parameters<typeof changeSince>): Promise<LineRange[]> {
  return (await changeSince(...args)).hunks.map((found) => rangeOf(found));
}

describe("changeSince", () => {
  let root = "";

  function write(path: string, content: string): void {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }

  function git(...args: string[]): string {
    const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });

    if (result.exitCode !== 0) throw new Error(result.stderr.toString());

    return result.stdout.toString().trim();
  }

  function commit(message: string): void {
    git("add", "-A");
    git("commit", "-qm", message);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mutation-"));
    git("init", "-q", "-b", "dev");
    // A CI runner carries no identity, and signing is on globally here.
    git("config", "user.name", "Mutation test");
    git("config", "user.email", "mutation@example.test");
    git("config", "commit.gpgsign", "false");
    write("a/listed.ts", "one\ntwo\nthree\n");
    write("b/unlisted.ts", "one\n");
    commit("Base");
    git("switch", "-q", "-c", "feature");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("the lines of the listed modules changed since the base, committed or not", async () => {
    write("a/listed.ts", "one\nTWO\nthree\n");
    commit("Change a line");
    write("a/listed.ts", "one\nTWO\nthree\nfour\n");
    write("b/unlisted.ts", "changed\n");

    expect(await linesSince(root, ["a/listed.ts"], "dev", NO_ACTIONS)).toEqual([
      { file: "a/listed.ts", start: 2, end: 2 },
      { file: "a/listed.ts", start: 4, end: 4 },
    ]);
  });

  test("a listed module's tests count, and the base is the merge-base", async () => {
    const since = git("rev-parse", "HEAD");
    write("a/listed.test.ts", "test\n");
    commit("Its tests");

    expect(await changeSince(root, ["a/listed.ts"], "dev", NO_ACTIONS)).toEqual({
      since,
      hunks: [hunk("a/listed.test.ts", 0, 0, 1, 1)],
    });
  });

  test("the tree at a commit, in a directory of its own", async () => {
    const at = git("rev-parse", "HEAD");
    write("a/listed.ts", "changed since\n");
    commit("Later");
    const dir = await snapshotAt(root, at);

    expect(readFileSync(join(dir, "a/listed.ts"), "utf8")).toBe("one\ntwo\nthree\n");
    rmSync(dir, { recursive: true, force: true });
  });

  test("none when the listed modules are untouched", async () => {
    write("b/unlisted.ts", "changed\n");

    expect(await linesSince(root, ["a/listed.ts"], "dev", NO_ACTIONS)).toEqual([]);
  });

  test("a pull request run measures from its merge commit's first parent, not the event's base", async () => {
    write("a/listed.ts", "one\ntwo\nthree\nfour\nfive\n");
    commit("Five lines");
    const stale = git("rev-parse", "HEAD");
    git("switch", "-q", "-C", "dev");
    git("switch", "-q", "-c", "pr");
    write("a/listed.ts", "ONE\ntwo\nthree\nfour\nfive\n");
    commit("The pull request's line");
    git("switch", "-q", "dev");
    write("a/listed.ts", "one\ntwo\nthree\nfour\nFIVE\n");
    commit("A line landed on dev since");
    // The checkout of a pull request's run: the merge of its head into the base's tip.
    git("switch", "-q", "--detach", "dev");
    git("merge", "-q", "--no-ff", "-m", "Merge pr", "pr");
    const event = join(root, ".git", "event.json");
    writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: stale } } }));

    const env = {
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: event,
    };

    expect(await linesSince(root, ["a/listed.ts"], undefined, env)).toEqual([
      { file: "a/listed.ts", start: 1, end: 1 },
    ]);
  });

  test("a push run measures from the commit the push moved the branch from", async () => {
    const before = git("rev-parse", "HEAD");
    write("a/listed.ts", "one\nTWO\nthree\n");
    commit("The pushed line");
    const event = join(root, ".git", "event.json");
    writeFileSync(event, JSON.stringify({ before, after: git("rev-parse", "HEAD") }));
    const env = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: event };

    expect(await linesSince(root, ["a/listed.ts"], undefined, env)).toEqual([
      { file: "a/listed.ts", start: 2, end: 2 },
    ]);
  });

  test("a push run without the commit it moved from fails, saying what is missing", async () => {
    const push = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push" };
    const event = join(root, ".git", "event.json");
    writeFileSync(event, JSON.stringify({ after: git("rev-parse", "HEAD") }));

    await expect(linesSince(root, ["a/listed.ts"], undefined, push)).rejects.toThrow(
      "GITHUB_EVENT_PATH is unset on a push run",
    );
    await expect(
      linesSince(root, ["a/listed.ts"], undefined, { ...push, GITHUB_EVENT_PATH: event }),
    ).rejects.toThrow(`${event} names no before`);
  });

  test("outside a pull request or a push the base is origin/dev", async () => {
    const dispatch = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch" };

    for (const env of [NO_ACTIONS, dispatch]) {
      await expect(linesSince(root, ["a/listed.ts"], undefined, env)).rejects.toThrow(
        "no merge-base with origin/dev",
      );
    }
  });

  test("a base it cannot find fails, naming it and quoting git", async () => {
    await expect(linesSince(root, ["a/listed.ts"], "origin/nowhere", NO_ACTIONS)).rejects.toThrow(
      /^no merge-base with origin\/nowhere: fatal: [^\n]+$/u,
    );
  });
});

interface Workflow {
  jobs: Record<string, { if?: string }>;
}

test("ci.yml mutation-tests every event but a push to main, which releases a tested dev", async () => {
  const source = await Bun.file(join(import.meta.dir, "../.github/workflows/ci.yml")).text();
  const { jobs }: Workflow = parse(source);

  expect(jobs["mutation"]?.if).toBe(
    "github.event_name != 'push' || github.ref == 'refs/heads/dev'",
  );
});

describe("a pass leaves the checkout as it found it", () => {
  const MUTATION = join(import.meta.dir, "mutation.ts");
  let root = "";

  /** Every file's bytes and mode, Stryker's own directory aside. */
  function snapshot() {
    const files = new Map<string, string>();

    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      const path = join(entry.parentPath, entry.name);

      if (!entry.isFile() || path.includes(".stryker-tmp")) continue;
      const hash = new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
      files.set(path.slice(root.length + 1), `${hash} ${statSync(path).mode.toString(8)}`);
    }

    return files;
  }

  function spawnPass(): Bun.Subprocess<"ignore", "pipe", "pipe"> {
    return Bun.spawn(
      [
        process.execPath,
        "-e",
        `await (await import(${JSON.stringify(MUTATION)})).mutate(${JSON.stringify(root)}, "mod.ts");`,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mutation-pass-"));
    writeFileSync(
      join(root, "mod.ts"),
      "export function positive(n: number): boolean {\n  return n > 0;\n}\n",
    );
    chmodSync(join(root, "mod.ts"), 0o755);

    writeFileSync(
      join(root, "mod.test.ts"),
      [
        'import { expect, test } from "bun:test";',
        'import { positive } from "./mod.ts";',
        'test("positive", async () => {',
        "  await Bun.sleep(200);",
        "  expect(positive(1)).toBe(true);",
        "  expect(positive(0)).toBe(false);",
        "});",
      ].join("\n"),
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("a pass that ends leaves every byte and mode as they were", async () => {
    const before = snapshot();
    const pass = spawnPass();
    await new Response(pass.stdout).text();

    expect(before.size).toBe(2);
    expect(await pass.exited).toBe(0);
    expect(snapshot()).toEqual(before);
  }, 60_000);

  test("a pass killed while its mutants run leaves every byte and mode as they were", async () => {
    const before = snapshot();
    const pass = spawnPass();
    const decoder = new TextDecoder();
    let output = "";

    for await (const chunk of pass.stdout) {
      output += decoder.decode(chunk);

      if (output.includes("Starting initial test run")) break;
    }

    pass.kill(9);
    await pass.exited;

    expect(before.size).toBe(2);
    expect(snapshot()).toEqual(before);
  }, 60_000);
});
