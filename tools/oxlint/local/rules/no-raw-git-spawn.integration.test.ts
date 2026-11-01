import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { $ } from "bun";

// oxlint's RuleTester refuses to run under Bun, so the rule runs through oxlint itself, on files
// written to a temporary directory it runs from: the exemptions read paths relative to its cwd.
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

const OXLINT = join(REPO_ROOT, "node_modules/oxlint/bin/oxlint");

const PLUGIN = join(import.meta.dir, "..", "index.ts");

const SOURCES = {
  "scripts/literal.ts": [
    'Bun.spawnSync(["git", "status"]);',
    'Bun.spawn({ cmd: ["git", "log"] });',
    'Bun.spawnSync(["ls"]);',
  ].join("\n"),
  "scripts/const-argv.ts": [
    'const argv = ["git", "-C", "/x", "ls-files"];',
    'let other = ["git", "status"];',
    "Bun.spawnSync(argv);",
    'Bun.spawnSync([...argv, "-z"]);',
    "Bun.spawnSync(other);",
    'other = ["ls"];',
  ].join("\n"),
  "scripts/shell.ts": [
    'import { $ } from "bun";',
    "const root = '/x';",
    "await $`git -C ${root} status`;",
    "await $`gitk`;",
    "await $`ls ${root}`;",
  ].join("\n"),
  "scripts/child.ts": [
    'import { execFileSync, spawn } from "node:child_process";',
    'import * as cp from "child_process";',
    'const GIT = "git";',
    'spawn("git", ["status"]);',
    'execFileSync(GIT, ["log"]);',
    'cp.spawnSync("git", ["fetch"]);',
    'spawn("ls", []);',
  ].join("\n"),
  "scripts/asserted.ts": [
    'Bun.spawnSync(["git", "status"] as const);',
    'Bun.spawnSync(["git", "log"] satisfies string[]);',
    'Bun.spawnSync(["ls"] as const);',
  ].join("\n"),
  "scripts/shell-line.ts": [
    'import { exec, execSync } from "node:child_process";',
    "const root = '/x';",
    'execSync("git status --porcelain");',
    "exec(`git -C ${root} fetch`, () => {});",
    'execSync("gitk");',
    'execSync("ls");',
    "const args = '-s';",
    'execSync("git status " + args);',
    'execSync("ls " + args);',
  ].join("\n"),
  "scripts/shell-option.ts": [
    'import { spawnSync } from "node:child_process";',
    'spawnSync("git status", { shell: true });',
    'spawnSync("git status", { shell: false });',
    'spawnSync("ls", { shell: true });',
  ].join("\n"),
  "scripts/local-bun.ts": [
    "const Bun = { spawnSync: (argv: string[]) => argv };",
    'Bun.spawnSync(["git", "status"]);',
  ].join("\n"),
  "todos/lib/platform/git.ts": 'Bun.spawnSync(["git", "status"]);\n',
  "tools/platform/git.ts": 'Bun.spawnSync(["git", "status"]);\n',
  "scripts/literal.test.ts": 'Bun.spawnSync(["git", "status"]);\n',
  "agent-hooks/test-support.ts": 'Bun.spawnSync(["git", "init"]);\n',
} as const;

type SourceName = keyof typeof SOURCES;

interface OxlintReport {
  diagnostics: {
    code: string;
    message: string;
    filename: string;
    labels: { span: { line: number } }[];
  }[];
}

let dir = "";

const reported = new Map<string, number[]>();

const messages = new Set<string>();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "no-raw-git-spawn-"));

  const config = join(dir, "oxlintrc.json");
  writeFileSync(
    config,
    JSON.stringify({
      jsPlugins: [{ name: "local", specifier: PLUGIN }],
      categories: { correctness: "off" },
      rules: { "local/no-raw-git-spawn": "error" },
    }),
  );

  for (const [name, source] of Object.entries(SOURCES)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), source);
  }

  const run = await $`${process.execPath} ${OXLINT} -c ${config} -f json .`
    .cwd(dir)
    .nothrow()
    .quiet();

  const report: OxlintReport = JSON.parse(run.stdout.toString());

  for (const diagnostic of report.diagnostics) {
    expect(diagnostic.code).toBe("local(no-raw-git-spawn)");
    const name = diagnostic.filename.replaceAll("\\", "/");
    reported.set(name, [...(reported.get(name) ?? []), diagnostic.labels[0]?.span.line ?? 0]);
    messages.add(diagnostic.message);
  }
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function lines(name: SourceName): number[] {
  return (reported.get(name) ?? []).toSorted((a, b) => a - b);
}

describe("no-raw-git-spawn", () => {
  test("reports Bun.spawn and Bun.spawnSync of an argv literal that starts with git", () => {
    expect(lines("scripts/literal.ts")).toEqual([1, 2]);
  });

  test("follows a const binding to its array literal, spread or not, and no let", () => {
    expect(lines("scripts/const-argv.ts")).toEqual([3, 4]);
  });

  test("reports bun's $ when its line starts with git", () => {
    expect(lines("scripts/shell.ts")).toEqual([3]);
  });

  test("reports node:child_process's spawners given git, by name or by a const", () => {
    expect(lines("scripts/child.ts")).toEqual([4, 5, 6]);
  });

  test("reads an argv literal past as const and satisfies", () => {
    expect(lines("scripts/asserted.ts")).toEqual([1, 2]);
  });

  test("reports exec and execSync given a shell line that starts with git, concatenated or not", () => {
    expect(lines("scripts/shell-line.ts")).toEqual([3, 4, 8]);
  });

  test("reports a spawner given a git line and a shell, and leaves shell: false", () => {
    expect(lines("scripts/shell-option.ts")).toEqual([2]);
  });

  test("leaves a local binding named Bun", () => {
    expect(lines("scripts/local-bun.ts")).toEqual([]);
  });

  test("names the module that holds the helpers", () => {
    expect(messages).toContain(
      "git started through Bun.spawn: use `git`, `gitRead` or their sync forms from `tools/platform/git.ts` (the directory's own copy in a plugin).",
    );
  });

  test("leaves the platform helpers, at their source and in a copy", () => {
    expect(lines("todos/lib/platform/git.ts")).toEqual([]);
    expect(lines("tools/platform/git.ts")).toEqual([]);
  });

  test("leaves a test and a test's support file", () => {
    expect(lines("scripts/literal.test.ts")).toEqual([]);
    expect(lines("agent-hooks/test-support.ts")).toEqual([]);
  });
});
