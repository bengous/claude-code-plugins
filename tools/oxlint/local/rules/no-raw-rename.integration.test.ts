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
  "scripts/named.ts": [
    'import { rename } from "node:fs/promises";',
    'import { renameSync as move } from "node:fs";',
    'await rename("a", "b");',
    'move("a", "b");',
  ].join("\n"),
  "scripts/whole.ts": [
    'import * as fs from "node:fs";',
    'import fsDefault, { promises } from "fs";',
    'fs.renameSync("a", "b");',
    'await fs.promises.rename("a", "b");',
    'await promises.rename("a", "b");',
    'fsDefault.renameSync("a", "b");',
  ].join("\n"),
  "scripts/const-alias.ts": [
    'import { renameSync } from "node:fs";',
    "const mv = renameSync;",
    'mv("a", "b");',
  ].join("\n"),
  "scripts/require-member.ts": [
    'require("node:fs").renameSync("a", "b");',
    'require("fs").promises.rename("a", "b");',
  ].join("\n"),
  "scripts/require-destructured.ts": [
    'const { renameSync, writeFileSync } = require("fs");',
    'renameSync("a", "b");',
    'writeFileSync("a", "b");',
  ].join("\n"),
  "scripts/import-member.ts": 'await (await import("node:fs/promises")).rename("a", "b");\n',
  "scripts/import-destructured.ts": [
    'const { rename: move } = await import("node:fs/promises");',
    'await move("a", "b");',
  ].join("\n"),
  "scripts/loaded-const.ts": [
    'const fs = require("node:fs");',
    'const fsp = await import("fs/promises");',
    'fs.renameSync("a", "b");',
    'await fsp.rename("a", "b");',
  ].join("\n"),
  "scripts/whole-destructured.ts": [
    'import * as fs from "node:fs";',
    "const { renameSync } = fs;",
    'renameSync("a", "b");',
  ].join("\n"),
  "scripts/required-promises-destructured.ts": [
    'const { rename } = require("fs").promises;',
    'await rename("a", "b");',
  ].join("\n"),
  "scripts/imported-promises-destructured.ts": [
    'import { promises } from "fs";',
    "const { rename } = promises;",
    'await rename("a", "b");',
  ].join("\n"),
  "scripts/nested-destructured.ts": [
    'const { promises: { rename } } = require("fs");',
    'await rename("a", "b");',
  ].join("\n"),
  "scripts/promises-const.ts": [
    'const fsp = require("fs").promises;',
    'await fsp.rename("a", "b");',
  ].join("\n"),
  "scripts/unrelated.ts": [
    'import { rename } from "./local.ts";',
    'import { writeFileSync } from "node:fs";',
    "const obj = { rename: 1, renameSync: 2 };",
    'await rename("a", "b");',
    'writeFileSync("a", String(obj.rename + obj.renameSync));',
    'const { rename: other } = require("./local.cjs");',
    'require("node:path").rename;',
    'await (await import("./local.ts")).rename("a", "b");',
    "other();",
    'const { promises: { rename: nested } } = require("./local.cjs");',
    'const { promises: { rename: deeper } } = require("fs/promises");',
    "const looped = looped;",
    'looped.rename("a", "b");',
    "nested(deeper);",
  ].join("\n"),
  "todos/lib/platform/fs.ts": 'import { renameSync } from "node:fs";\nrenameSync("a", "b");\n',
  "tools/platform/fs.ts": 'import { renameSync } from "node:fs";\nrenameSync("a", "b");\n',
  "scripts/named.test.ts": 'import { renameSync } from "node:fs";\nrenameSync("a", "b");\n',
  "vellum/src/fixtures/tree.ts": 'import { renameSync } from "node:fs";\nrenameSync("a", "b");\n',
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
  dir = mkdtempSync(join(tmpdir(), "no-raw-rename-"));

  const config = join(dir, "oxlintrc.json");
  writeFileSync(
    config,
    JSON.stringify({
      jsPlugins: [{ name: "local", specifier: PLUGIN }],
      categories: { correctness: "off" },
      rules: { "local/no-raw-rename": "error" },
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
    expect(diagnostic.code).toBe("local(no-raw-rename)");
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

describe("no-raw-rename", () => {
  test("reports each use of rename and renameSync imported by name, an alias included", () => {
    expect(lines("scripts/named.ts")).toEqual([3, 4]);
  });

  test("reports them read off the whole module, its default, or its promises", () => {
    expect(lines("scripts/whole.ts")).toEqual([3, 4, 5, 6]);
  });

  test("reports renameSync where a const binding takes it", () => {
    expect(lines("scripts/const-alias.ts")).toEqual([2]);
  });

  test("reports renameSync and rename read off a require of fs, its promises included", () => {
    expect(lines("scripts/require-member.ts")).toEqual([1, 2]);
  });

  test("reports renameSync destructured from a require of fs, once, at the binding", () => {
    expect(lines("scripts/require-destructured.ts")).toEqual([1]);
  });

  test("reports rename read off an await import() of fs/promises", () => {
    expect(lines("scripts/import-member.ts")).toEqual([1]);
  });

  test("reports rename destructured from an await import() of fs/promises, an alias included", () => {
    expect(lines("scripts/import-destructured.ts")).toEqual([1]);
  });

  test("reports a rename read off a const that holds a require or an await import() of fs", () => {
    expect(lines("scripts/loaded-const.ts")).toEqual([3, 4]);
  });

  test("reports renameSync destructured from fs imported whole", () => {
    expect(lines("scripts/whole-destructured.ts")).toEqual([2]);
  });

  test("reports rename destructured from the promises of a require of fs", () => {
    expect(lines("scripts/required-promises-destructured.ts")).toEqual([1]);
  });

  test("reports rename destructured from the promises imported from fs", () => {
    expect(lines("scripts/imported-promises-destructured.ts")).toEqual([2]);
  });

  test("reports rename destructured from the promises nested in a require of fs", () => {
    expect(lines("scripts/nested-destructured.ts")).toEqual([1]);
  });

  test("reports rename read off a const that holds the promises of a require of fs", () => {
    expect(lines("scripts/promises-const.ts")).toEqual([2]);
  });

  test("leaves a rename of another module, required, loaded or imported, and a property spelled rename", () => {
    expect(lines("scripts/unrelated.ts")).toEqual([]);
  });

  test("names the module that holds the helpers", () => {
    expect(messages).toContain(
      "`rename` from `node:fs/promises` renames without the platform helpers: use `rename`, `renameSync` or `writeAtomic` from `tools/platform/fs.ts` (the directory's own copy in a plugin).",
    );
  });

  test("leaves the platform helpers, at their source and in a copy", () => {
    expect(lines("todos/lib/platform/fs.ts")).toEqual([]);
    expect(lines("tools/platform/fs.ts")).toEqual([]);
  });

  test("leaves a test and a fixture", () => {
    expect(lines("scripts/named.test.ts")).toEqual([]);
    expect(lines("vellum/src/fixtures/tree.ts")).toEqual([]);
  });
});
