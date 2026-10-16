import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import config from "../stryker.config.ts";
import {
  changedLines,
  changedRanges,
  describeSurvivor,
  githubOutput,
  type Mutant,
  mutateSpec,
  parseArgs,
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

test("a range in Stryker's --mutate spelling", () => {
  expect(mutateSpec({ file: "agent-hooks/config.ts", start: 8, end: 9 })).toBe(
    "agent-hooks/config.ts:8-9",
  );
});

test("CI's output says whether there is a line to mutate", () => {
  expect(githubOutput([{ file: "a.ts", start: 1, end: 1 }])).toBe("mutate=true\n");
  expect(githubOutput([])).toBe("mutate=false\n");
});

test("a run mutates every range, against each module's tests once", () => {
  expect(
    runOptions([
      { file: "scripts/changelog.ts", start: 3, end: 4 },
      { file: "scripts/changelog.ts", start: 9, end: 9 },
      { file: "agent-hooks/config.ts", start: 1, end: 2 },
    ]),
  ).toEqual({
    mutate: ["scripts/changelog.ts:3-4", "scripts/changelog.ts:9-9", "agent-hooks/config.ts:1-2"],
    commandRunner: { command: "bun test ./scripts/changelog.test.ts ./agent-hooks/config.test.ts" },
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

  test("outside a pull request the base is origin/dev", async () => {
    await expect(changedLines(root, ["a/listed.ts"], undefined, NO_ACTIONS)).rejects.toThrow(
      "no merge-base with origin/dev",
    );
  });

  test("a base it cannot find fails, naming it and quoting git", async () => {
    await expect(changedLines(root, ["a/listed.ts"], "origin/nowhere", NO_ACTIONS)).rejects.toThrow(
      /^no merge-base with origin\/nowhere: fatal: [^\n]+$/u,
    );
  });
});
