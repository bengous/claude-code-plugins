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

const RAW_WRITE = 'import { writeFileSync } from "node:fs";\nwriteFileSync("a", "b");\n';

const SOURCES = {
  "scripts/named.ts": [
    'import { writeFile } from "node:fs/promises";',
    'import { writeFileSync as put } from "node:fs";',
    'await writeFile("a", "b");',
    'put("a", "b");',
  ].join("\n"),
  "scripts/whole.ts": [
    'import * as fs from "node:fs";',
    'import fsDefault, { promises } from "fs";',
    'fs.writeFileSync("a", "b");',
    'await fs.promises.writeFile("a", "b");',
    'await promises.writeFile("a", "b");',
    'fsDefault.writeFileSync("a", "b");',
  ].join("\n"),
  "scripts/loaded.ts": [
    'require("node:fs").writeFileSync("a", "b");',
    'const { writeFile } = require("fs/promises");',
    'const { writeFile: put } = await import("node:fs/promises");',
    'const { promises: { writeFile: nested } } = require("fs");',
    'const { promises } = require("fs");',
    'await promises.writeFile("a", "b");',
    'const { default: whole } = await import("node:fs");',
    'whole.writeFileSync("a", "b");',
    "await writeFile(put, nested);",
  ].join("\n"),
  "scripts/called-later.ts": [
    'import { writeFileSync } from "node:fs";',
    "const put = writeFileSync;",
    'put("a", "b", { flag: "wx" });',
  ].join("\n"),
  "goalify/evals/regrade.ts": [
    'import { readFile, writeFile } from "node:fs/promises";',
    'const rows = (await readFile("results.jsonl", "utf8")).split("\\n");',
    'await writeFile("results.jsonl", rows.join("\\n") + "\\n");',
  ].join("\n"),
  "scripts/bun-write.ts": [
    'await Bun.write("a", "b");',
    'await Bun.write(Bun.file("a"), "b");',
    'const dest = Bun.file("a");',
    'await Bun.write(dest, "b");',
    'await Bun.file("a").write("b");',
    'const file = Bun.file("a");',
    'await file.write("b");',
  ].join("\n"),
  "scripts/bun-imported.ts": [
    'import { file, write } from "bun";',
    'import * as B from "bun";',
    'await write("a", "b");',
    'await B.write("a", "b");',
    'await file("a").write("b");',
  ].join("\n"),
  "scripts/bun-aliased.ts": [
    "const B = Bun;",
    'await B.write("a", "b");',
    'const m = await import("bun");',
    'await m.write("a", "b");',
    "const { write: put, file } = Bun;",
    'await put("a", "b");',
    'await file("a").write("b");',
    'const { write: later } = require("bun");',
    'await later("a", "b");',
  ].join("\n"),
  "scripts/fd-variable.ts": [
    "export async function log(fd: number): Promise<void> {",
    '  await Bun.write(fd, "b");',
    "}",
  ].join("\n"),
  "scripts/not-writes.ts": [
    'import { appendFile, appendFileSync, copyFile, copyFileSync, createWriteStream, openSync, writeFileSync } from "node:fs";',
    'import { open, writeFile } from "node:fs/promises";',
    'writeFileSync(1, "b");',
    'writeFileSync("a", "b", { flag: "a" });',
    'await writeFile("a", "b", { flag: "as" });',
    "type Port = { write: typeof writeFileSync };",
    "const { stdout } = Bun;",
    'await Bun.write(stdout, "b");',
    'appendFileSync("a", "b");',
    'appendFile("a", "b", () => {});',
    'createWriteStream("a");',
    'openSync("a", "w");',
    'await open("a", "w");',
    'copyFileSync("a", "b");',
    'copyFile("a", "b", () => {});',
    'await Bun.write(Bun.stdout, "b");',
    'await Bun.write(Bun.stderr, "b");',
    'await Bun.write(1, "b");',
    'await Bun.write(Bun.file(2), "b");',
    "const out = Bun.stdout;",
    'await Bun.write(out, "b");',
    'Bun.file("a").writer().write("b");',
    'process.stdout.write("b");',
  ].join("\n"),
  "scripts/other-write-file.ts": [
    'import { writeFile as local } from "./local.ts";',
    "const ports = { writeFile: async (file: string, text: string) => [file, text] };",
    'await ports.writeFile("a", "b");',
    "function writeFile(file: string, text: string) {",
    '  return { kind: "writeFile", file, text };',
    "}",
    'writeFile("a", "b");',
    "const vellum = { writeFile: (name: string) => name };",
    'vellum.writeFile("a");',
    'local("a");',
    'const { writeFile: other } = require("./local.cjs");',
    'other("a");',
  ].join("\n"),
  "scripts/shadowed-bun.ts": [
    "const Bun = { write: (path: string) => path, file: (path: string) => ({ write: () => path }) };",
    'Bun.write("a");',
    'Bun.file("a").write();',
  ].join("\n"),
  "tools/platform/fs.ts": RAW_WRITE,
  "todos/lib/platform/fs.ts": RAW_WRITE,
  "vellum/src/platform/fs.ts": RAW_WRITE,
  "scripts/named.test.ts": RAW_WRITE,
  "vellum/src/a.spec.ts": RAW_WRITE,
  "scripts/land.fixture.ts": RAW_WRITE,
  "agent-hooks/test-support.ts": RAW_WRITE,
  "vellum/e2e/harness.ts": RAW_WRITE,
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
  dir = mkdtempSync(join(tmpdir(), "no-raw-write-"));

  const config = join(dir, "oxlintrc.json");
  writeFileSync(
    config,
    JSON.stringify({
      jsPlugins: [{ name: "local", specifier: PLUGIN }],
      categories: { correctness: "off" },
      rules: { "local/no-raw-write": "error" },
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
    expect(diagnostic.code).toBe("local(no-raw-write)");
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

describe("no-raw-write", () => {
  test("reports each use of writeFile and writeFileSync imported by name, an alias included", () => {
    expect(lines("scripts/named.ts")).toEqual([3, 4]);
  });

  test("reports them read off the whole module, its default, or its promises", () => {
    expect(lines("scripts/whole.ts")).toEqual([3, 4, 5, 6]);
  });

  test("reports them read off or destructured from a require or an await import() of fs", () => {
    expect(lines("scripts/loaded.ts")).toEqual([1, 2, 3, 4, 6, 8]);
  });

  test("reports a writeFileSync taken as a value, where its call is out of sight", () => {
    expect(lines("scripts/called-later.ts")).toEqual([2]);
  });

  test("reports Bun.write and Bun.file read off Bun held in a const, loaded, or destructured", () => {
    expect(lines("scripts/bun-aliased.ts")).toEqual([2, 4, 6, 7, 9]);
  });

  test("reports the write of a file read, regraded and written back whole", () => {
    expect(lines("goalify/evals/regrade.ts")).toEqual([3]);
  });

  test("reports Bun.write to a path or a Bun.file of one, and Bun.file(…).write", () => {
    expect(lines("scripts/bun-write.ts")).toEqual([1, 2, 4, 5, 7]);
  });

  test("reports write and file imported from bun, by name or whole", () => {
    expect(lines("scripts/bun-imported.ts")).toEqual([3, 4, 5]);
  });

  test("reports Bun.write to an fd held in a variable, which the AST does not tell from a path", () => {
    expect(lines("scripts/fd-variable.ts")).toEqual([2]);
  });

  test("leaves an append, a numbered fd, a stream, an open, a copy, a typeof, and Bun.write to stdout, stderr or an fd", () => {
    expect(lines("scripts/not-writes.ts")).toEqual([]);
  });

  test("leaves a writeFile of another module or object, and a function spelled writeFile", () => {
    expect(lines("scripts/other-write-file.ts")).toEqual([]);
  });

  test("leaves a local binding named Bun", () => {
    expect(lines("scripts/shadowed-bun.ts")).toEqual([]);
  });

  test("names the helpers to use", () => {
    expect(messages).toContain(
      "`writeFileSync` from `node:fs` writes a whole file in place: use `writeAtomic` or `writeAtomicSync` from `tools/platform/fs.ts` (the directory's own copy in a plugin).",
    );
    expect(messages).toContain(
      "`Bun.write` writes a whole file in place: use `writeAtomic` or `writeAtomicSync` from `tools/platform/fs.ts` (the directory's own copy in a plugin).",
    );
  });

  test("leaves the platform helpers, at their source and in a copy", () => {
    expect(lines("tools/platform/fs.ts")).toEqual([]);
    expect(lines("todos/lib/platform/fs.ts")).toEqual([]);
    expect(lines("vellum/src/platform/fs.ts")).toEqual([]);
  });

  test("leaves a test and what only tests load", () => {
    for (const name of [
      "scripts/named.test.ts",
      "vellum/src/a.spec.ts",
      "scripts/land.fixture.ts",
      "agent-hooks/test-support.ts",
      "vellum/e2e/harness.ts",
    ] as const) {
      expect({ name, lines: lines(name) }).toEqual({ name, lines: [] });
    }
  });
});
