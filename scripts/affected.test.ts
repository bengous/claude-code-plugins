import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  classify,
  currentScope,
  githubOutput,
  kitsOf,
  type PathClass,
  scopeOf,
  testRuns,
} from "./affected.ts";

const SCRIPT = join(import.meta.dir, "affected.ts");

const NO_ACTIONS = {};

describe("classify", () => {
  const rows: [string, PathClass][] = [
    ["archive/claude-orchestration/old.test.ts", { kind: "none" }],
    [".claude/hooks/stop-gates.ts", { kind: "unit", unit: ".claude/hooks" }],
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

describe("what the scope runs", () => {
  test("its units' suites beside scripts/, in one run", () => {
    expect(testRuns({ kind: "units", units: [".claude/hooks", "todos"] })).toEqual([
      ["test", "--parallel", "./scripts/", "./.claude/hooks/", "./todos/"],
    ]);
  });

  test("every suite, the repo's own hooks in a run of their own", () => {
    expect(testRuns({ kind: "all", reason: "bunfig.toml reaches every suite" })).toEqual([
      ["test", "--parallel"],
      ["test", "--parallel", "./.claude/hooks/"],
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

  test("a pull request run takes its base from the event's payload", async () => {
    const base = git("rev-parse", "dev");
    write("todos/scan.ts", "committed\n");
    commit("Change todos");
    // Under .git/, where neither the diff nor the untracked listing looks.
    const event = join(root, ".git", "event.json");
    writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: base } } }));

    const env = {
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: event,
    };

    expect(await currentScope(root, undefined, env)).toEqual({ kind: "units", units: ["todos"] });
  });

  test("any other Actions run checks everything", async () => {
    const env = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push" };

    expect(await currentScope(root, undefined, env)).toEqual({
      kind: "all",
      reason: "a push run checks everything",
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
      GITHUB_EVENT_NAME: "push",
      GITHUB_OUTPUT: output,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(readFileSync(output, "utf8")).toBe(
    'earlier=1\nall=true\nunits=[]\nkits=["vellum","todos"]\n',
  );
  rmSync(dir, { recursive: true, force: true });
});
