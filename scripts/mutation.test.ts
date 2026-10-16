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
  changedLines,
  changedRanges,
  describeSurvivor,
  githubOutput,
  moduleVerdict,
  modulesOf,
  type Mutant,
  onChangedLines,
  parseArgs,
  rangeLabel,
  runOptions,
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

  test("a hunk that only deletes, or a deleted file, leaves no line to mutate", () => {
    const diff = [
      "diff --git a/scripts/changelog.ts b/scripts/changelog.ts",
      "--- a/scripts/changelog.ts",
      "+++ b/scripts/changelog.ts",
      "@@ -10,2 +9,0 @@",
      "diff --git a/agent-hooks/config.ts b/agent-hooks/config.ts",
      "deleted file mode 100644",
      "--- a/agent-hooks/config.ts",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
    ].join("\n");

    expect(changedRanges(diff)).toEqual([]);
  });
});

test("a range reads file:start-end", () => {
  expect(rangeLabel({ file: "agent-hooks/config.ts", start: 8, end: 9 })).toBe(
    "agent-hooks/config.ts:8-9",
  );
});

test("the modules the ranges fall in, each once, in order", () => {
  expect(
    modulesOf([
      { file: "b.ts", start: 1, end: 1 },
      { file: "a.ts", start: 3, end: 4 },
      { file: "b.ts", start: 9, end: 9 },
    ]),
  ).toEqual(["b.ts", "a.ts"]);
});

test("CI's output says whether there is a line to mutate", () => {
  expect(githubOutput([{ file: "a.ts", start: 1, end: 1 }])).toBe("mutate=true\n");
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

describe("onChangedLines", () => {
  const at = (start: number, end: number, status: Mutant["status"] = "Survived"): Mutant =>
    mutant({
      location: { start: { line: start, column: 1 }, end: { line: end, column: 2 } },
      status,
    });

  test("keeps an undetected mutant that meets a changed line, one spanning past it included", () => {
    const changed = [{ file: "agent-hooks/config.ts", start: 15, end: 15 }];

    const kept = onChangedLines(
      [at(10, 20), at(15, 15), at(14, 14), at(16, 30), at(15, 15, "Killed")],
      changed,
    );

    expect(kept.map(({ location }) => `${location.start.line}-${location.end.line}`)).toEqual([
      "10-20",
      "15-15",
    ]);
  });

  test("keeps one that meets any of several ranges", () => {
    const changed = [
      { file: "agent-hooks/config.ts", start: 3, end: 3 },
      { file: "agent-hooks/config.ts", start: 9, end: 9 },
    ];

    expect(onChangedLines([at(3, 3), at(9, 9), at(6, 6)], changed)).toHaveLength(2);
  });

  test("keeps one that touches a range at either edge", () => {
    const changed = [{ file: "agent-hooks/config.ts", start: 5, end: 7 }];

    expect(onChangedLines([at(1, 5), at(7, 9), at(1, 4), at(8, 9)], changed)).toHaveLength(2);
  });
});

describe("moduleVerdict", () => {
  const source = ["const a = 1;", "if (a > 0) {", "  run();", "}", "const b = a + 1;"].join("\n");
  const changed = [{ file: "x/mod.ts", start: 2, end: 2 }];

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
    expect(moduleVerdict("x/mod.ts", source, results, changed)).toEqual({
      survivors: ["x/mod.ts:2:5 Survived EqualityOperator: a > 0 => a >= 0"],
      summary:
        "mutation: x/mod.ts: 3 mutant(s) tested, 1 undetected on the changed lines, 1 elsewhere, outside this change",
    });
  });

  test("has no survivor when only lines outside the change keep one", () => {
    const elsewhere = [{ file: "x/mod.ts", start: 3, end: 3 }];

    expect(moduleVerdict("x/mod.ts", source, results, elsewhere).survivors).toEqual([]);
  });
});

describe("changedLines", () => {
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

    expect(await changedLines(root, ["a/listed.ts"], "dev", NO_ACTIONS)).toEqual([
      { file: "a/listed.ts", start: 2, end: 2 },
      { file: "a/listed.ts", start: 4, end: 4 },
    ]);
  });

  test("none when the listed modules are untouched", async () => {
    write("b/unlisted.ts", "changed\n");

    expect(await changedLines(root, ["a/listed.ts"], "dev", NO_ACTIONS)).toEqual([]);
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

    expect(await changedLines(root, ["a/listed.ts"], undefined, env)).toEqual([
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

    expect(await changedLines(root, ["a/listed.ts"], undefined, env)).toEqual([
      { file: "a/listed.ts", start: 2, end: 2 },
    ]);
  });

  test("a push run without the commit it moved from fails, saying what is missing", async () => {
    const push = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push" };
    const event = join(root, ".git", "event.json");
    writeFileSync(event, JSON.stringify({ after: git("rev-parse", "HEAD") }));

    await expect(changedLines(root, ["a/listed.ts"], undefined, push)).rejects.toThrow(
      "GITHUB_EVENT_PATH is unset on a push run",
    );
    await expect(
      changedLines(root, ["a/listed.ts"], undefined, { ...push, GITHUB_EVENT_PATH: event }),
    ).rejects.toThrow(`${event} names no before`);
  });

  test("outside a pull request or a push the base is origin/dev", async () => {
    const dispatch = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch" };

    for (const env of [NO_ACTIONS, dispatch]) {
      await expect(changedLines(root, ["a/listed.ts"], undefined, env)).rejects.toThrow(
        "no merge-base with origin/dev",
      );
    }
  });

  test("a base it cannot find fails, naming it and quoting git", async () => {
    await expect(changedLines(root, ["a/listed.ts"], "origin/nowhere", NO_ACTIONS)).rejects.toThrow(
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
