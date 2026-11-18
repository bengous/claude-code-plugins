import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "./config.ts";

let dir: string;

let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "agent-hooks-config-"));
  file = path.join(dir, "agent-hooks.jsonc");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function load(jsonc: string): ReturnType<typeof loadConfig> {
  writeFileSync(file, jsonc);

  return loadConfig(file);
}

function failure(jsonc: string): string {
  try {
    load(jsonc);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("the config loaded");
}

describe("loadConfig", () => {
  test("reads the brief's example: fixers in declaration order, lanes with their defaults", () => {
    const config = load(`{
      // generated or vendored
      "exclude": ["**/node_modules/**"],
      "cap": 2,
      "fixers": {
        "oxlint": { "on": "**/*.{ts,tsx}", "file": "oxlint --fix --quiet {file}", "loop": true },
        "prettier": { "on": "**/*.{ts,md}", "exclude": ["plans/**"], "stdin": "prettier --stdin-filepath {path}", "at": "both" },
      },
      "lanes": {
        "lint": { "on": "**/*.ts", "takes": "files", "run": "oxlint --format=unix {files}", "timeout": 1.5 },
        "clippy": { "on": "**/*.rs", "takes": "project", "cwd": "pkg", "run": "cargo clippy", "verdict": "note" },
      },
    }`);

    expect(config).toEqual({
      file,
      exclude: ["**/node_modules/**"],
      cap: 2,
      fixers: [
        {
          name: "oxlint",
          on: "**/*.{ts,tsx}",
          exclude: [],
          run: { kind: "file", command: "oxlint --fix --quiet {file}" },
          loop: true,
          at: "edit",
        },
        {
          name: "prettier",
          on: "**/*.{ts,md}",
          exclude: ["plans/**"],
          run: { kind: "stdin", command: "prettier --stdin-filepath {path}" },
          loop: false,
          at: "both",
        },
      ],
      lanes: [
        {
          name: "lint",
          on: "**/*.ts",
          exclude: [],
          takes: "files",
          cwd: "root",
          run: "oxlint --format=unix {files}",
          verdict: "block",
          timeoutMs: 1500,
        },
        {
          name: "clippy",
          on: "**/*.rs",
          exclude: [],
          takes: "project",
          cwd: "pkg",
          run: "cargo clippy",
          verdict: "note",
          timeoutMs: 60_000,
        },
      ],
    });
  });

  test("an empty object is a config with no fixer, no lane and a cap of 3", () => {
    expect(load("{}")).toEqual({ file, exclude: [], cap: 3, fixers: [], lanes: [] });
  });

  test("a cap of 1 and a fraction of a second are valid", () => {
    expect(
      load(
        '{ "cap": 1, "lanes": { "l": { "on": "*", "takes": "files", "run": "l", "timeout": 0.25 } } }',
      ),
    ).toMatchObject({ cap: 1, lanes: [{ timeoutMs: 250 }] });
  });

  test.each([
    ['{ "presets": ["ts"] }', "presets: unknown key"],
    ['{ "extends": [] }', "extends: unknown key"],
    ['{ "profile": {} }', "profile: unknown key"],
    ['{ "pre-edit": {} }', "pre-edit: unknown key"],
    ['{ "stop": {} }', "stop: unknown key"],
    [
      '{ "fixers": { "f": { "on": "*", "file": "f {file}", "disabled": true } } }',
      "fixers.f.disabled: unknown key",
    ],
    [
      '{ "lanes": { "l": { "on": "*", "takes": "files", "run": "l", "disabled": true } } }',
      "lanes.l.disabled: unknown key",
    ],
  ])(
    "refuses an unknown key, the keys of the presets and sections gone included: %s",
    (jsonc, message) => {
      expect(failure(jsonc)).toBe(`agent-hooks: ${file}: ${message}`);
    },
  );

  test.each([
    ['{ "exclude": "dist/**" }', "exclude: expected an array of strings"],
    ['{ "cap": 0 }', "cap: expected a positive integer"],
    ['{ "cap": 1.5 }', "cap: expected a positive integer"],
    ['{ "cap": "3" }', "cap: expected a positive integer"],
    [
      '{ "lanes": { "l": { "on": "*", "takes": "files", "run": "l", "timeout": "5" } } }',
      "lanes.l.timeout: expected a number of seconds",
    ],
    [
      '{ "lanes": { "l": { "on": "*", "takes": "files", "run": "l", "timeout": 1e999 } } }',
      "lanes.l.timeout: expected a number of seconds",
    ],
    ['{ "fixers": [] }', "fixers: expected an object"],
    ['{ "fixers": { "f": { "on": 1, "file": "f {file}" } } }', "fixers.f.on: expected a string"],
    [
      '{ "fixers": { "f": { "on": "*", "file": "f {file}", "loop": "yes" } } }',
      "fixers.f.loop: expected a boolean",
    ],
    [
      '{ "fixers": { "f": { "on": "*", "file": "f {file}", "at": "write" } } }',
      "fixers.f.at: expected edit|stop|both",
    ],
    [
      '{ "lanes": { "l": { "on": "*", "takes": "all", "run": "l" } } }',
      "lanes.l.takes: expected files|project",
    ],
    [
      '{ "lanes": { "l": { "on": "*", "takes": "files", "run": "l", "cwd": "src" } } }',
      "lanes.l.cwd: expected root|pkg",
    ],
    [
      '{ "lanes": { "l": { "on": "*", "takes": "files", "run": "l", "verdict": "warn" } } }',
      "lanes.l.verdict: expected block|note",
    ],
    [
      '{ "lanes": { "l": { "on": "*", "takes": "files", "run": "l", "timeout": 0 } } }',
      "lanes.l.timeout: expected a number of seconds",
    ],
  ])("refuses a value of the wrong type with its key path: %s", (jsonc, message) => {
    expect(failure(jsonc)).toBe(`agent-hooks: ${file}: ${message}`);
  });

  test.each([
    [
      '{ "fixers": { "f": { "on": "*" } } }',
      'fixers.f: expected exactly one of "file" and "stdin"',
    ],
    [
      '{ "fixers": { "f": { "on": "*", "file": "a {file}", "stdin": "b" } } }',
      'fixers.f: expected exactly one of "file" and "stdin"',
    ],
    ['{ "fixers": { "f": { "file": "a {file}" } } }', 'fixers.f: missing "on"'],
    ['{ "lanes": { "l": { "on": "*", "run": "l" } } }', 'lanes.l: missing "takes"'],
    ['{ "lanes": { "l": { "on": "*", "takes": "files" } } }', 'lanes.l: missing "run"'],
    ['{ "lanes": { "l": { "takes": "files", "run": "l" } } }', 'lanes.l: missing "on"'],
  ])("refuses a fixer or a lane missing what it needs: %s", (jsonc, message) => {
    expect(failure(jsonc)).toBe(`agent-hooks: ${file}: ${message}`);
  });

  test.each([
    [
      '{ "fixers": { "f": { "on": "*", "file": "f {files}" } } }',
      "fixers.f.file: unknown placeholder {files}",
    ],
    [
      '{ "fixers": { "f": { "on": "*", "stdin": "f {name}" } } }',
      "fixers.f.stdin: unknown placeholder {name}",
    ],
    [
      '{ "lanes": { "l": { "on": "*", "takes": "files", "run": "l {file}" } } }',
      "lanes.l.run: unknown placeholder {file}",
    ],
  ])("refuses a placeholder its command does not take: %s", (jsonc, message) => {
    expect(failure(jsonc)).toBe(`agent-hooks: ${file}: ${message}`);
  });

  test.each([
    [
      '{ "fixers": { "f": { "on": "*", "file": "cargo fmt" } } }',
      "fixers.f.file: a file fixer must name {file}, the copy it rewrites",
    ],
    [
      '{ "fixers": { "f": { "on": "*", "file": "eslint --fix {path}" } } }',
      "fixers.f.file: a file fixer must name {file}, the copy it rewrites",
    ],
    [
      '{ "fixers": { "f": { "on": "*", "file": "fix {file} --as {path}" } } }',
      "fixers.f.file: a file fixer may not name {path}, the real file: it rewrites {file}",
    ],
    [
      '{ "fixers": { "f": { "on": "*", "stdin": "fmt {file}" } } }',
      "fixers.f.stdin: a stdin fixer may not name {file}: it reads the content on stdin",
    ],
  ])("refuses a fixer that could rewrite a real file: %s", (jsonc, message) => {
    expect(failure(jsonc)).toBe(`agent-hooks: ${file}: ${message}`);
  });

  test("names the file it cannot read or parse", () => {
    expect(() => loadConfig(path.join(dir, "none.jsonc"))).toThrow(
      `agent-hooks: ${path.join(dir, "none.jsonc")}: cannot read:`,
    );
    expect(failure("{ nope")).toStartWith(`agent-hooks: ${file}: invalid JSONC:`);
    expect(failure("[]")).toBe(`agent-hooks: ${file}: expected an object`);
  });
});
