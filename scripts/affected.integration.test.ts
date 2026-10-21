import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  baseOf,
  classify,
  currentScope,
  githubOutput,
  integrationWorkers,
  kitsOf,
  type PathClass,
  readArgs,
  scopeOf,
  testRuns,
} from "./affected.ts";

const SCRIPT = join(import.meta.dir, "affected.ts");

const NO_ACTIONS = {};

describe("classify", () => {
  const rows: [string, PathClass][] = [
    ["archive/claude-orchestration/old.test.ts", { kind: "none" }],
    [".claude/hooks/guard-git-push.ts", { kind: "unit", unit: ".claude/hooks" }],
    ["README.md", { kind: "gates" }],
    ["docs/repo-ops/checks.md", { kind: "gates" }],
    [".claude-plugin/marketplace.json", { kind: "gates" }],
    [".claude/rules/hook-ladder.md", { kind: "gates" }],
    ["scripts/run-gates.ts", { kind: "all" }],
    ["tools/oxlint/lint-contract.json", { kind: "all" }],
    [".github/workflows/ci.yml", { kind: "all" }],
    [".lefthook/pre-push/gates-and-tests.sh", { kind: "all" }],
    [".claude/settings.json", { kind: "all" }],
    [".gitattributes", { kind: "all" }],
    ["bunfig.toml", { kind: "all" }],
    ["todos/hooks/scan.ts", { kind: "unit", unit: "todos" }],
    ["session-archive/session-archive.ts", { kind: "unit", unit: "session-archive" }],
    ["vellum/README.md", { kind: "unit", unit: "vellum" }],
  ];

  test.each(rows)("%s", (path, expected) => {
    expect(classify(path)).toEqual(expected);
  });
});

describe("scopeOf", () => {
  test("one path that reaches everything outweighs every unit, and says which", () => {
    expect(scopeOf(["todos/hooks/scan.ts", "scripts/run-gates.ts"])).toEqual({
      kind: "all",
      reason: "scripts/run-gates.ts reaches every suite",
    });
  });

  test("is the units the paths touch, each once, sorted", () => {
    expect(scopeOf(["vellum/a.ts", "todos/b.ts", "todos/c.ts", "README.md"])).toEqual({
      kind: "units",
      units: ["todos", "vellum"],
    });
  });

  test("gates and archived paths alone touch no unit", () => {
    expect(scopeOf(["docs/plugin-testing.md", "AGENTS.md", "archive/x/y.ts"])).toEqual({
      kind: "units",
      units: [],
    });
  });
});

describe("readArgs", () => {
  test("a command, its base, and a retry job for test alone", () => {
    expect(readArgs(["print"])).toEqual({ command: "print", base: undefined, retryJob: undefined });
    expect(readArgs(["test", "--base", "HEAD~2", "--retry", "validate"])).toEqual({
      command: "test",
      base: "HEAD~2",
      retryJob: "validate",
    });
  });

  test("refuses an unknown command or flag, a flag with no value, a retry outside test", () => {
    expect(readArgs([])).toBeNull();
    expect(readArgs(["lint"])).toBeNull();
    expect(readArgs(["test", "--ref", "HEAD"])).toBeNull();
    expect(readArgs(["test", "--base"])).toBeNull();
    expect(readArgs(["test", "extra"])).toBeNull();
    expect(readArgs(["print", "--retry", "validate"])).toBeNull();
  });
});

describe("what the scope runs", () => {
  const UNIT_RUN = [
    "test",
    "--parallel",
    "--path-ignore-patterns=archive/**",
    "--path-ignore-patterns=**/*.integration.test.ts",
    "--path-ignore-patterns=**/*.integration.test.tsx",
    "--path-ignore-patterns=**/*.integration.spec.ts",
    "--path-ignore-patterns=**/*.integration.spec.tsx",
  ];

  const INTEGRATION_RUN = ["test", "--parallel=3", "--timeout=20000"];

  const suites = {
    ignored: ["archive/**"],
    unit: ["scripts/affected.test.ts", ".claude/hooks/guard.test.ts", "todos/hooks/scan.spec.ts"],
    integration: [
      "scripts/land.integration.test.ts",
      ".claude/hooks/auto-sweep.integration.test.ts",
      "vellum/src/standalone.integration.spec.ts",
    ],
    workers: 3,
  };

  test("the integration run takes half the cores, two at least", () => {
    expect([1, 2, 4, 5, 16].map((cores) => integrationWorkers(cores))).toEqual([2, 2, 2, 2, 8]);
  });

  test("its units' suites beside scripts/, then the integration files among them by name", () => {
    expect(testRuns({ kind: "units", units: [".claude/hooks", "todos"] }, suites)).toEqual([
      [...UNIT_RUN, "./scripts/", "./.claude/hooks/", "./todos/"],
      [
        ...INTEGRATION_RUN,
        "./scripts/land.integration.test.ts",
        "./.claude/hooks/auto-sweep.integration.test.ts",
      ],
    ]);
  });

  test("no integration run when the scope holds no integration file", () => {
    expect(testRuns({ kind: "units", units: ["todos"] }, { ...suites, integration: [] })).toEqual([
      [...UNIT_RUN, "./scripts/", "./todos/"],
    ]);
  });

  test("a unit whose tests are all integration ones is left out of the unit run", () => {
    expect(testRuns({ kind: "units", units: ["vellum"] }, suites)).toEqual([
      [...UNIT_RUN, "./scripts/"],
      [
        ...INTEGRATION_RUN,
        "./scripts/land.integration.test.ts",
        "./vellum/src/standalone.integration.spec.ts",
      ],
    ]);
    expect(testRuns({ kind: "units", units: [] }, { ...suites, unit: [] })).toEqual([
      [...INTEGRATION_RUN, "./scripts/land.integration.test.ts"],
    ]);
  });

  test("every suite, the repo's own hooks in a run of their own, then every integration file", () => {
    expect(testRuns({ kind: "all", reason: "bunfig.toml reaches every suite" }, suites)).toEqual([
      UNIT_RUN,
      [...UNIT_RUN, "./.claude/hooks/"],
      [...INTEGRATION_RUN, ...suites.integration.map((path) => `./${path}`)],
    ]);
  });

  test("the kits of the hooks modules among its units, in catalog order, or all of them", () => {
    const units = { kind: "units", units: ["todos", "git"] } as const;

    expect(kitsOf(units, ["vellum", "todos"])).toEqual(["todos"]);
    expect(kitsOf({ kind: "all", reason: "" }, ["vellum", "todos"])).toEqual(["vellum", "todos"]);
  });

  test("for GitHub Actions: whether all runs, the units and the kits, one output a line", () => {
    expect(githubOutput({ kind: "units", units: ["todos"] }, ["todos"])).toBe(
      'all=false\nunits=["todos"]\nkits=["todos"]\n',
    );
    expect(githubOutput({ kind: "all", reason: "" }, ["vellum", "todos"])).toBe(
      'all=true\nunits=[]\nkits=["vellum","todos"]\n',
    );
  });
});

describe("currentScope", () => {
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

  function commit(message: string): string {
    git("add", "-A");
    git("commit", "-qm", message);

    return git("rev-parse", "HEAD");
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "affected-"));
    git("init", "-q", "-b", "dev");
    // A CI runner carries no identity, and signing is on globally here.
    git("config", "user.name", "Affected test");
    git("config", "user.email", "affected@example.test");
    git("config", "commit.gpgsign", "false");
    write("todos/scan.ts", "base\n");
    write("vellum/serve.ts", "base\n");
    commit("Base");
    git("switch", "-q", "-c", "feature");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("sees a file committed since the base, one changed and one never added", async () => {
    write("todos/scan.ts", "committed\n");
    commit("Change todos");
    write("vellum/serve.ts", "changed\n");
    write("git-sweep/new.ts", "untracked\n");

    expect(await currentScope(root, "dev", NO_ACTIONS)).toEqual({
      kind: "units",
      units: ["git-sweep", "todos", "vellum"],
    });
  });

  test("a base it cannot find runs everything, and says why", async () => {
    const scope = await currentScope(root, "origin/nowhere", NO_ACTIONS);

    expect(scope.kind).toBe("all");
    expect(scope.kind === "all" && scope.reason).toStartWith("no merge-base with origin/nowhere");
  });

  test("a pull request run measures from its merge commit's first parent, not the event's base", async () => {
    const stale = git("rev-parse", "dev");
    write("todos/scan.ts", "committed\n");
    commit("Change todos");
    git("switch", "-q", "dev");
    write("vellum/serve.ts", "landed on dev since\n");
    commit("Land on dev");
    // The checkout of a pull request's run: the merge of its head into the base's tip.
    git("switch", "-q", "--detach", "dev");
    git("merge", "-q", "--no-ff", "-m", "Merge feature", "feature");
    const event = join(root, ".git", "event.json");
    writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: stale } } }));

    const env = {
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: event,
    };

    expect(await currentScope(root, undefined, env)).toEqual({ kind: "units", units: ["todos"] });
  });

  test("a push run checks everything, whatever it pushed", async () => {
    const event = join(root, ".git", "event.json");
    writeFileSync(event, JSON.stringify({ before: git("rev-parse", "HEAD") }));
    const env = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: event };

    expect(await currentScope(root, undefined, env)).toEqual({
      kind: "all",
      reason: "a push run checks everything",
    });
  });

  test("any other Actions run checks everything", async () => {
    const env = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch" };

    expect(await currentScope(root, undefined, env)).toEqual({
      kind: "all",
      reason: "a workflow_dispatch run checks everything",
    });
  });
});

describe("baseOf", () => {
  test("a push run's base is the commit the push moved the branch from", async () => {
    const dir = mkdtempSync(join(tmpdir(), "affected-event-"));
    const event = join(dir, "event.json");
    writeFileSync(event, JSON.stringify({ before: "0123abc", after: "4567def" }));
    const env = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: event };

    expect(await baseOf(undefined, env)).toEqual({ kind: "push", before: "0123abc" });
    rmSync(dir, { recursive: true, force: true });
  });

  test("a push run without its event's before fails, saying what is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "affected-event-"));
    const event = join(dir, "event.json");
    writeFileSync(event, JSON.stringify({ after: "4567def" }));
    const push = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push" };

    await expect(baseOf(undefined, push)).rejects.toThrow(
      "GITHUB_EVENT_PATH is unset on a push run",
    );
    await expect(baseOf(undefined, { ...push, GITHUB_EVENT_PATH: event })).rejects.toThrow(
      `${event} names no before`,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("an explicit base wins over any event", async () => {
    expect(await baseOf("HEAD~3", { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push" })).toEqual({
      kind: "ref",
      ref: "HEAD~3",
    });
  });
});

test("github-output appends its lines to $GITHUB_OUTPUT, the kits read off the catalog", () => {
  const dir = mkdtempSync(join(tmpdir(), "affected-output-"));
  const output = join(dir, "output");
  writeFileSync(output, "earlier=1\n");

  const result = Bun.spawnSync([process.execPath, SCRIPT, "github-output"], {
    env: {
      ...process.env,
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_OUTPUT: output,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(readFileSync(output, "utf8")).toBe(
    'earlier=1\nall=true\nunits=[]\nkits=["vellum","todos","secret-pane","pinpoint","atlas","wrap-archive"]\n',
  );
  rmSync(dir, { recursive: true, force: true });
});
