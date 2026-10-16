import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import type { Fixer, Lane } from "./config.ts";
import { deadlineIn, run } from "./exec.ts";
import type { FixOptions, FixTarget, LaneOptions, LaneResult } from "./lanes.ts";
import {
  MAX_FIX_PASSES,
  PROJECT_FILE,
  failingOf,
  formatReport,
  greenKey,
  greenSlot,
  groupsOf,
  isFailure,
  laneRuns,
  runFixers,
  runLanes,
  selectFiles,
} from "./lanes.ts";
import { diagnosticKey } from "./loop-guard.ts";
import type { TempRepo } from "./test-support.ts";
import {
  createTempRepo,
  fakeTool,
  readRepoFile,
  removeTempRepo,
  scrubGitEnv,
  writeRepoFile,
} from "./test-support.ts";

const temps: TempRepo[] = [];

beforeEach(() => {
  scrubGitEnv();
});

afterEach(() => {
  for (const temp of temps.splice(0)) {
    removeTempRepo(temp);
  }
});

function tempRepo(files: Readonly<Record<string, string>> = {}): string {
  const temp = createTempRepo("agent-hooks-lanes-", files);
  temps.push(temp);

  return temp.repo;
}

function laneOf(overrides: Partial<Lane> & Pick<Lane, "name">): Lane {
  return {
    on: "**/*",
    exclude: [],
    takes: "files",
    cwd: "root",
    run: "true",
    verdict: "block",
    timeoutMs: 20_000,
    disabled: false,
    ...overrides,
  };
}

function fixerOf(overrides: Partial<Fixer> & Pick<Fixer, "name">): Fixer {
  return { on: "**/*", exclude: [], loop: false, disabled: false, ...overrides };
}

function resultOf(overrides: Partial<LaneResult> & Pick<LaneResult, "lane">): LaneResult {
  return {
    pkg: ".",
    run: "ok",
    output: "",
    key: null,
    failingFiles: [],
    diagnostics: {},
    ms: 0,
    ...overrides,
  };
}

function optionsFor(root: string, overrides: Partial<LaneOptions> = {}): LaneOptions {
  return {
    root,
    runner: run,
    deadline: deadlineIn(20_000),
    green: null,
    head: "head1",
    digest: "digest1",
    exclude: [],
    ...overrides,
  };
}

function only<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);
  const [first] = items;

  if (first === undefined) {
    throw new Error("expected one item");
  }

  return first;
}

function fixOptions(root: string): FixOptions {
  return { root, runner: run, deadline: deadlineIn(20_000) };
}

function targetIn(repo: string, relativePath: string): FixTarget {
  return { relativePath, file: path.join(repo, relativePath) };
}

async function previousKey(repo: string, lane: Lane): Promise<string> {
  const result = only(await runLanes([lane], ["a.ts"], optionsFor(repo)));
  expect(result.run).toBe("ok");

  if (result.key === null) {
    throw new Error("an ok run has a key");
  }

  return result.key;
}

function markerTool(repo: string): string {
  const marker = path.join(repo, "spawned");
  fakeTool(repo, "check", `touch "${marker}"`);

  return marker;
}

function lines(file: string): string[] {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
}

const RECORDER = 'log="$1"; shift; echo "$PWD $*" >> "$log"';

describe("selectFiles", () => {
  test("a files lane drops a file of pre-edit.exclude, a project lane keeps it", () => {
    const repo = tempRepo({ "dist/bundle.js": "x\n", "src/a.js": "x\n" });
    const scope = ["dist/bundle.js", "src/a.js"];
    const files = laneOf({ name: "lint", on: "**/*.js", takes: "files" });
    const project = laneOf({ name: "build", on: "**/*.js", takes: "project" });

    expect(selectFiles(files, scope, repo, ["dist/**"])).toEqual(["src/a.js"]);
    expect(selectFiles(project, scope, repo, ["dist/**"])).toEqual(scope);
  });

  test("keeps the paths `on` matches minus `exclude`", () => {
    const repo = tempRepo({ "src/a.ts": "", "src/a.test.ts": "", "README.md": "" });
    const lane = laneOf({ name: "lint", on: "**/*.ts", exclude: ["**/*.test.ts"] });

    expect(selectFiles(lane, ["src/a.ts", "src/a.test.ts", "README.md"], repo)).toEqual([
      "src/a.ts",
    ]);
  });

  test("a files lane drops the paths gone from disk", () => {
    const repo = tempRepo({ "a.ts": "" });
    const lane = laneOf({ name: "lint", on: "**/*.ts", takes: "files" });

    expect(selectFiles(lane, ["a.ts", "gone.ts"], repo)).toEqual(["a.ts"]);
  });

  test("a project lane keeps the paths gone from disk", () => {
    const repo = tempRepo({ "a.ts": "" });
    const lane = laneOf({ name: "typecheck", on: "**/*.ts", takes: "project" });

    expect(selectFiles(lane, ["a.ts", "gone.ts"], repo)).toEqual(["a.ts", "gone.ts"]);
  });
});

describe("groupsOf", () => {
  const crates = {
    "a/Cargo.toml": "",
    "a/src/lib.rs": "",
    "b/Cargo.toml": "",
    "b/src/lib.rs": "",
    "top.rs": "",
  };

  test("a root lane makes one group whose pkg is the root", () => {
    const repo = tempRepo(crates);
    const lane = laneOf({ name: "lint", cwd: "root" });

    expect(groupsOf(lane, ["a/src/lib.rs", "b/src/lib.rs"], repo)).toEqual([
      { pkg: repo, files: ["a/src/lib.rs", "b/src/lib.rs"] },
    ]);
  });

  test("a pkg lane makes one group per crate", () => {
    const repo = tempRepo(crates);
    const lane = laneOf({ name: "clippy", cwd: "pkg" });

    expect(groupsOf(lane, ["a/src/lib.rs", "b/src/lib.rs"], repo)).toEqual([
      { pkg: path.join(repo, "a"), files: ["a/src/lib.rs"] },
      { pkg: path.join(repo, "b"), files: ["b/src/lib.rs"] },
    ]);
  });

  test("a file outside any crate goes to the root group", () => {
    const repo = tempRepo(crates);
    const lane = laneOf({ name: "clippy", cwd: "pkg" });

    expect(groupsOf(lane, ["top.rs", "a/src/lib.rs"], repo)).toEqual([
      { pkg: repo, files: ["top.rs"] },
      { pkg: path.join(repo, "a"), files: ["a/src/lib.rs"] },
    ]);
  });
});

describe("greenKey", () => {
  const base = greenKey("lint", ".", ["oxlint", "a.ts"], "head1", "digest1");

  test("is stable for the same inputs", () => {
    expect(greenKey("lint", ".", ["oxlint", "a.ts"], "head1", "digest1")).toBe(base);
  });

  test("changes with the lane name, the pkg, the argv, the head and the digest", () => {
    const variants = [
      greenKey("test", ".", ["oxlint", "a.ts"], "head1", "digest1"),
      greenKey("lint", "a", ["oxlint", "a.ts"], "head1", "digest1"),
      greenKey("lint", ".", ["oxlint", "b.ts"], "head1", "digest1"),
      greenKey("lint", ".", ["oxlint", "a.ts"], "head2", "digest1"),
      greenKey("lint", ".", ["oxlint", "a.ts"], null, "digest1"),
      greenKey("lint", ".", ["oxlint", "a.ts"], "head1", "digest2"),
    ];

    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  test("greenSlot joins the lane and the pkg", () => {
    expect(greenSlot("lint", ".")).toBe("lint@.");
  });
});

describe("runLanes", () => {
  test("a lane whose selection is empty yields one skipped result", async () => {
    const repo = tempRepo({ "a.ts": "" });

    const results = await runLanes(
      [laneOf({ name: "clippy", on: "**/*.rs" })],
      ["a.ts"],
      optionsFor(repo),
    );

    const result = only(results);
    expect(result.run).toBe("skipped");
    expect(result.pkg).toBe(".");
    expect(isFailure(result)).toBeFalse();
  });

  test("a disabled lane yields no result", async () => {
    const repo = tempRepo({ "a.ts": "" });

    const results = await runLanes(
      [laneOf({ name: "lint", disabled: true })],
      ["a.ts"],
      optionsFor(repo),
    );

    expect(results).toEqual([]);
  });

  test("a pkg lane runs once per crate, in the crate dir, with only that crate's files", async () => {
    const repo = tempRepo({
      "a/Cargo.toml": "",
      "a/src/lib.rs": "",
      "b/Cargo.toml": "",
      "b/src/lib.rs": "",
      "b/src/main.rs": "",
    });

    fakeTool(repo, "rec", RECORDER);

    const lane = laneOf({
      name: "clippy",
      on: "**/*.rs",
      cwd: "pkg",
      run: "rec {root}/log.txt {files}",
    });

    const results = await runLanes(
      [lane],
      ["a/src/lib.rs", "b/src/lib.rs", "b/src/main.rs"],
      optionsFor(repo),
    );

    expect(results.map((result) => [result.pkg, result.run])).toEqual([
      ["a", "ok"],
      ["b", "ok"],
    ]);
    const real = realpathSync(repo);
    expect(lines(path.join(repo, "log.txt")).toSorted()).toEqual([
      `${real}/a src/lib.rs`,
      `${real}/b src/lib.rs src/main.rs`,
    ]);
  });

  test("lanes run in parallel", async () => {
    const repo = tempRepo({ "a.ts": "" });
    fakeTool(repo, "slow", "sleep 1");
    const lanes = [laneOf({ name: "one", run: "slow" }), laneOf({ name: "two", run: "slow" })];

    const started = Date.now();
    const results = await runLanes(lanes, ["a.ts"], optionsFor(repo));

    expect(Date.now() - started).toBeLessThan(1800);
    expect(results.map((result) => result.run)).toEqual(["ok", "ok"]);
  });

  test("a lane past its timeout is cut short", async () => {
    const repo = tempRepo({ "a.ts": "" });
    fakeTool(repo, "hang", "sleep 3");

    const started = Date.now();

    const results = await runLanes(
      [laneOf({ name: "lint", run: "hang", timeoutMs: 1000 })],
      ["a.ts"],
      optionsFor(repo),
    );

    expect(Date.now() - started).toBeLessThan(2600);
    const result = only(results);
    expect(result.run).toBe("timeout");
    expect(result.output).toContain("timed out after 1000 ms");
    expect(isFailure(result)).toBeTrue();
  });

  test("the deadline caps the lane timeout", async () => {
    const repo = tempRepo({ "a.ts": "" });
    fakeTool(repo, "hang", "sleep 3");

    const results = await runLanes(
      [laneOf({ name: "lint", run: "hang", timeoutMs: 60_000 })],
      ["a.ts"],
      optionsFor(repo, { deadline: deadlineIn(300) }),
    );

    expect(only(results).run).toBe("timeout");
  });

  describe("green cache", () => {
    test("a group whose key matches the previous ok run does not spawn", async () => {
      const repo = tempRepo({ "a.ts": "" });
      fakeTool(repo, "check", "exit 0");
      const lane = laneOf({ name: "lint", run: "check {files}" });
      const key = await previousKey(repo, lane);
      const marker = markerTool(repo);

      const result = only(
        await runLanes([lane], ["a.ts"], optionsFor(repo, { green: { "lint@.": key } })),
      );

      expect(result.run).toBe("green");
      expect(result.key).toBe(key);
      expect(existsSync(marker)).toBeFalse();
    });

    test.each([
      ["a different digest", { digest: "digest2" }],
      ["a different head", { head: "head2" }],
    ] as const)("%s runs again", async (_label, overrides) => {
      const repo = tempRepo({ "a.ts": "" });
      fakeTool(repo, "check", "exit 0");
      const lane = laneOf({ name: "lint", run: "check {files}" });
      const key = await previousKey(repo, lane);
      const marker = markerTool(repo);

      const result = only(
        await runLanes(
          [lane],
          ["a.ts"],
          optionsFor(repo, { green: { "lint@.": key }, ...overrides }),
        ),
      );

      expect(result.run).toBe("ok");
      expect(existsSync(marker)).toBeTrue();
    });

    test("a changed run command runs again", async () => {
      const repo = tempRepo({ "a.ts": "" });
      fakeTool(repo, "check", "exit 0");
      const key = await previousKey(repo, laneOf({ name: "lint", run: "check {files}" }));
      const marker = markerTool(repo);

      const changed = laneOf({ name: "lint", run: "check --strict {files}" });

      const result = only(
        await runLanes([changed], ["a.ts"], optionsFor(repo, { green: { "lint@.": key } })),
      );

      expect(result.run).toBe("ok");
      expect(existsSync(marker)).toBeTrue();
    });
  });

  test("a missing binary yields a missing run", async () => {
    const repo = tempRepo({ "a.ts": "" });

    const result = only(
      await runLanes(
        [laneOf({ name: "lint", run: "agent-hooks-no-such-tool {files}" })],
        ["a.ts"],
        optionsFor(repo),
      ),
    );

    expect(result.run).toBe("missing");
    expect(result.output).toBe("command not found: agent-hooks-no-such-tool");
    expect(result.failingFiles).toEqual(["a.ts"]);
    expect(isFailure(result)).toBeTrue();
  });

  describe("failing files", () => {
    test("are the group files the output names", async () => {
      const repo = tempRepo({ "a.ts": "BAD\n", "b.ts": "good\n" });
      fakeTool(
        repo,
        "lint",
        'for f in "$@"; do grep -q BAD "$f" && echo "$f:1:1: bad"; done; exit 1',
      );

      const result = only(
        await runLanes(
          [laneOf({ name: "lint", run: "lint {files}" })],
          ["a.ts", "b.ts"],
          optionsFor(repo),
        ),
      );

      expect(result.run).toBe("fail");
      expect(result.output).toBe("a.ts:1:1: bad");
      expect(result.failingFiles).toEqual(["a.ts"]);
    });

    test("are the whole group for a files lane whose output names none", async () => {
      const repo = tempRepo({ "a.ts": "", "b.ts": "" });
      fakeTool(repo, "lint", "echo boom; exit 1");

      const result = only(
        await runLanes(
          [laneOf({ name: "lint", run: "lint {files}" })],
          ["a.ts", "b.ts"],
          optionsFor(repo),
        ),
      );

      expect(result.failingFiles).toEqual(["a.ts", "b.ts"]);
      expect(result.diagnostics).toEqual({});
    });

    test("are the project for a project lane whose output names none", async () => {
      const repo = tempRepo({ "a.ts": "" });
      fakeTool(repo, "typecheck", "echo boom; exit 1");

      const result = only(
        await runLanes(
          [laneOf({ name: "tsc", takes: "project", run: "typecheck" })],
          ["a.ts"],
          optionsFor(repo),
        ),
      );

      expect(result.failingFiles).toEqual([PROJECT_FILE]);
    });

    test("diagnostics count the output lines that name each file", async () => {
      const repo = tempRepo({ "a.ts": "", "b.ts": "" });
      fakeTool(
        repo,
        "lint",
        'echo "a.ts:1:1: bad"; echo "a.ts:2:1: bad"; echo "b.ts:1:1: bad"; echo "2 errors"; exit 1',
      );

      const result = only(
        await runLanes(
          [laneOf({ name: "lint", run: "lint {files}" })],
          ["a.ts", "b.ts"],
          optionsFor(repo),
        ),
      );

      expect(result.diagnostics).toEqual({
        [diagnosticKey("lint", "a.ts")]: 2,
        [diagnosticKey("lint", "b.ts")]: 1,
      });
    });
  });

  test("{files} gives one argument per file, and a path with a space stays one argument", async () => {
    const repo = tempRepo({ "a.ts": "", "dir with space/b.ts": "" });
    fakeTool(
      repo,
      "count",
      'log="$1"; shift; echo "$#" > "$log"; for f in "$@"; do echo "$f" >> "$log"; done',
    );

    const result = only(
      await runLanes(
        [laneOf({ name: "lint", run: "count {root}/args.txt {files}" })],
        ["a.ts", "dir with space/b.ts"],
        optionsFor(repo),
      ),
    );

    expect(result.run).toBe("ok");
    expect(lines(path.join(repo, "args.txt"))).toEqual(["2", "a.ts", "dir with space/b.ts"]);
  });

  test("a note lane is returned like the others", async () => {
    const repo = tempRepo({ "a.ts": "" });
    fakeTool(repo, "lint", "echo boom; exit 1");

    const result = only(
      await runLanes(
        [laneOf({ name: "lint", verdict: "note", run: "lint {files}" })],
        ["a.ts"],
        optionsFor(repo),
      ),
    );

    expect(result.run).toBe("fail");
    expect(result.lane.verdict).toBe("note");
    expect(isFailure(result)).toBeTrue();
  });
});

describe("laneRuns", () => {
  const clippy = laneOf({ name: "clippy" });
  const lint = laneOf({ name: "lint" });

  test("keeps the worst run per lane across groups", () => {
    const runs = laneRuns([
      resultOf({ lane: clippy, pkg: "a", run: "ok" }),
      resultOf({ lane: clippy, pkg: "b", run: "fail" }),
      resultOf({ lane: clippy, pkg: "c", run: "green" }),
      resultOf({ lane: lint, run: "green" }),
    ]);

    expect(runs).toEqual({ clippy: "fail", lint: "green" });
  });

  test("ok beats green, and timeout beats missing", () => {
    expect(
      laneRuns([
        resultOf({ lane: clippy, pkg: "a", run: "green" }),
        resultOf({ lane: clippy, pkg: "b", run: "ok" }),
        resultOf({ lane: lint, pkg: "a", run: "missing" }),
        resultOf({ lane: lint, pkg: "b", run: "timeout" }),
      ]),
    ).toEqual({ clippy: "ok", lint: "timeout" });
  });
});

describe("failingOf", () => {
  test("merges the files per lane across groups and skips the passing results", () => {
    const clippy = laneOf({ name: "clippy" });
    const lint = laneOf({ name: "lint" });

    const summary = failingOf([
      resultOf({
        lane: clippy,
        pkg: "a",
        run: "fail",
        failingFiles: ["a/x.rs"],
        diagnostics: { [diagnosticKey("clippy", "a/x.rs")]: 1 },
      }),
      resultOf({
        lane: clippy,
        pkg: "b",
        run: "timeout",
        failingFiles: ["b/y.rs", "a/x.rs"],
        diagnostics: { [diagnosticKey("clippy", "b/y.rs")]: 2 },
      }),
      resultOf({ lane: lint, run: "ok", failingFiles: ["ignored.ts"] }),
    ]);

    expect(summary).toEqual({
      failing: { clippy: ["a/x.rs", "b/y.rs"] },
      diagnostics: {
        [diagnosticKey("clippy", "a/x.rs")]: 1,
        [diagnosticKey("clippy", "b/y.rs")]: 2,
      },
    });
  });
});

describe("formatReport", () => {
  const clippy = laneOf({ name: "clippy" });
  const lint = laneOf({ name: "lint" });

  const failures = [
    resultOf({ lane: lint, run: "fail", output: "a.ts:1:1: bad\n" }),
    resultOf({ lane: clippy, pkg: "a", run: "fail", output: "error in a" }),
    resultOf({ lane: clippy, pkg: "b", run: "fail", output: "error in b" }),
  ];

  test("writes one section per failure, tags the pkg only for a lane with several failing groups", () => {
    expect(formatReport(failures, "block")).toBe(
      [
        "Stop validation failed:",
        "### lint\na.ts:1:1: bad",
        "### clippy [a]\nerror in a",
        "### clippy [b]\nerror in b",
      ].join("\n\n"),
    );
  });

  test("heads a note report as a note, without any fix instruction", () => {
    const report = formatReport(failures, "note");

    expect(report).toStartWith("Stop notes, no block:\n\n### lint");
    expect(report).not.toContain("Fix the errors");
  });
});

describe("runFixers", () => {
  test(`a looping fixer that changes the file on each pass stops after ${MAX_FIX_PASSES} passes`, async () => {
    const repo = tempRepo({ "a.ts": "" });
    fakeTool(repo, "grow", 'echo x >> "$1"; echo pass >> "$2"');
    const fixers = [fixerOf({ name: "grow", file: "grow {file} {root}/passes.log", loop: true })];

    const failures = await runFixers(fixers, targetIn(repo, "a.ts"), fixOptions(repo));

    expect(failures).toEqual([]);
    expect(lines(path.join(repo, "passes.log"))).toHaveLength(MAX_FIX_PASSES);
  });

  test("the looping fixers run first, then the others once, each in the configured order", async () => {
    const repo = tempRepo({ "a.ts": "" });
    fakeTool(repo, "rec", 'echo "$2" >> "$1"');

    const fixers = ["once1", "loop1", "once2", "loop2"].map((name) =>
      fixerOf({ name, file: `rec {root}/order.log ${name}`, loop: name.startsWith("loop") }),
    );

    await runFixers(fixers, targetIn(repo, "a.ts"), fixOptions(repo));

    expect(lines(path.join(repo, "order.log"))).toEqual(["loop1", "loop2", "once1", "once2"]);
  });

  test("a stdin fixer that exits 1 leaves the file unchanged", async () => {
    const repo = tempRepo({ "a.ts": "a  b\n" });
    fakeTool(repo, "squeeze", "sed 's/  */ /g'; exit 1");

    await runFixers(
      [fixerOf({ name: "squeeze", stdin: "squeeze" })],
      targetIn(repo, "a.ts"),
      fixOptions(repo),
    );

    expect(readRepoFile(repo, "a.ts")).toBe("a  b\n");
  });

  test("a stdin fixer with an empty stdout leaves the file unchanged", async () => {
    const repo = tempRepo({ "a.ts": "a  b\n" });
    fakeTool(repo, "silent", "cat > /dev/null");

    const failures = await runFixers(
      [fixerOf({ name: "silent", stdin: "silent" })],
      targetIn(repo, "a.ts"),
      fixOptions(repo),
    );

    expect(failures).toEqual([]);
    expect(readRepoFile(repo, "a.ts")).toBe("a  b\n");
  });

  test("a stdin fixer that exits 0 with output rewrites the file", async () => {
    const repo = tempRepo({ "a.ts": "a  b\n" });
    fakeTool(repo, "squeeze", "sed 's/  */ /g'");

    const failures = await runFixers(
      [fixerOf({ name: "squeeze", stdin: "squeeze" })],
      targetIn(repo, "a.ts"),
      fixOptions(repo),
    );

    expect(failures).toEqual([]);
    expect(readRepoFile(repo, "a.ts")).toBe("a b\n");
  });

  test("a non-looping fixer that exits 1 returns its failure with the stderr tail", async () => {
    const repo = tempRepo({ "a.ts": "" });
    fakeTool(repo, "fmt", 'echo "a.ts:3:4: syntax error" >&2; exit 1');

    const failures = await runFixers(
      [fixerOf({ name: "fmt", file: "fmt {file}" })],
      targetIn(repo, "a.ts"),
      fixOptions(repo),
    );

    expect(failures).toEqual(["fmt\na.ts:3:4: syntax error"]);
  });

  test("a looping fixer that exits 1 after a rewrite returns no failure and keeps the content", async () => {
    const repo = tempRepo({ "a.ts": "broken\n" });
    fakeTool(repo, "fix", 'echo fixed > "$1"; echo "1 problem left" >&2; exit 1');

    const failures = await runFixers(
      [fixerOf({ name: "fix", file: "fix {file}", loop: true })],
      targetIn(repo, "a.ts"),
      fixOptions(repo),
    );

    expect(failures).toEqual([]);
    expect(readRepoFile(repo, "a.ts")).toBe("fixed\n");
  });

  test.each([
    ["exclude", { exclude: ["**/*.ts"] }],
    ["disabled", { disabled: true }],
  ] as const)("%s skips a fixer", async (_label, overrides) => {
    const repo = tempRepo({ "a.ts": "" });
    const marker = path.join(repo, "spawned");
    fakeTool(repo, "fmt", `touch "${marker}"`);

    await runFixers(
      [fixerOf({ name: "fmt", file: "fmt {file}", ...overrides })],
      targetIn(repo, "a.ts"),
      fixOptions(repo),
    );

    expect(existsSync(marker)).toBeFalse();
  });

  test("a fixer whose binary is missing reports on stderr and returns no failure", async () => {
    const repo = tempRepo({ "a.ts": "" });
    const stderr = spyOn(console, "error").mockImplementation(() => {});

    try {
      const failures = await runFixers(
        [fixerOf({ name: "fmt", file: "agent-hooks-no-such-tool {file}" })],
        targetIn(repo, "a.ts"),
        fixOptions(repo),
      );

      expect(failures).toEqual([]);
      expect(stderr).toHaveBeenCalledWith(
        "agent-hooks: fmt: command not found: agent-hooks-no-such-tool",
      );
    } finally {
      stderr.mockRestore();
    }
  });

  test("fixers run with the root as cwd", async () => {
    const repo = tempRepo({ "pkg/package.json": "{}", "pkg/a.ts": "" });
    fakeTool(repo, "where", 'pwd > "$1"');

    await runFixers(
      [fixerOf({ name: "where", file: "where {root}/cwd.txt" })],
      targetIn(repo, "pkg/a.ts"),
      fixOptions(repo),
    );

    expect(readRepoFile(repo, "cwd.txt").trim()).toBe(realpathSync(repo));
  });

  test("{path} is the repo-relative path and {pkg} the nearest package", async () => {
    const repo = tempRepo({ "pkg/package.json": "{}", "pkg/a.ts": "" });
    fakeTool(repo, "rec", 'echo "$2 $3" > "$1"');
    writeRepoFile(repo, "scratch/a.ts", "");

    await runFixers(
      [fixerOf({ name: "rec", file: "rec {root}/vars.txt {path} {pkg}" })],
      { relativePath: "pkg/a.ts", file: path.join(repo, "scratch/a.ts") },
      fixOptions(repo),
    );

    expect(readRepoFile(repo, "vars.txt").trim()).toBe(`pkg/a.ts ${path.join(repo, "pkg")}`);
  });
});
