import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expandCommand, isExcluded, matchesFilter, pkgOf, splitCommand } from "./command.ts";
import { writeRepoFile } from "./test-support.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "agent-hooks-command-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("splitCommand", () => {
  test("splits on spaces", () => {
    expect(splitCommand("  a  b\tc ")).toEqual(["a", "b", "c"]);
  });

  test("keeps single and double quoted arguments with their spaces", () => {
    expect(splitCommand(`tool 'a b' "c d" e`)).toEqual(["tool", "a b", "c d", "e"]);
  });

  test("joins a quoted part to its word", () => {
    expect(splitCommand(`--name="a b" x`)).toEqual(["--name=a b", "x"]);
  });

  test("keeps an empty quoted argument", () => {
    expect(splitCommand(`tool ""`)).toEqual(["tool", ""]);
  });

  test("an empty string has no words", () => {
    expect(splitCommand("")).toEqual([]);
  });
});

describe("expandCommand", () => {
  const vars = { root: "/r", pkg: "/r/p", file: "/r/p/a.ts", path: "p/a.ts" };

  test("fills {root}, {pkg}, {file} and {path}", () => {
    expect(expandCommand("tool -c {root}/x.ts --pkg={pkg} {file} {path}", vars)).toEqual([
      "tool",
      "-c",
      "/r/x.ts",
      "--pkg=/r/p",
      "/r/p/a.ts",
      "p/a.ts",
    ]);
  });

  test("{files} expands to one argument per file, a space in a name included", () => {
    expect(
      expandCommand("tool --x {files} --y", { root: "/r", pkg: "/r", files: ["a b.ts", "c.ts"] }),
    ).toEqual(["tool", "--x", "a b.ts", "c.ts", "--y"]);
  });

  test("a command that is only {files} with no files is null", () => {
    expect(expandCommand("{files}", { root: "/r", pkg: "/r", files: [] })).toBeNull();
    expect(expandCommand("{files}", { root: "/r", pkg: "/r" })).toBeNull();
  });

  test("a command that is only {files} runs the first file as the program", () => {
    expect(expandCommand("{files}", { root: "/r", pkg: "/r", files: ["a.sh", "b"] })).toEqual([
      "a.sh",
      "b",
    ]);
  });

  test("an empty command is null", () => {
    expect(expandCommand("", vars)).toBeNull();
  });
});

describe("pkgOf", () => {
  test("the nearest ancestor with a package.json", () => {
    writeRepoFile(root, "apps/web/package.json", "{}");
    writeRepoFile(root, "package.json", "{}");

    expect(pkgOf(root, "apps/web/src/deep/a.ts")).toBe(path.join(root, "apps/web"));
  });

  test("the nearest ancestor with a Cargo.toml", () => {
    writeRepoFile(root, "crates/tool/Cargo.toml", "");

    expect(pkgOf(root, "crates/tool/src/main.rs")).toBe(path.join(root, "crates/tool"));
  });

  test("the root when no ancestor holds a manifest", () => {
    mkdirSync(path.join(root, "src"));

    expect(pkgOf(root, "src/a.ts")).toBe(root);
  });

  test("the root itself when it holds a manifest", () => {
    writeRepoFile(root, "package.json", "{}");

    expect(pkgOf(root, "src/a.ts")).toBe(root);
    expect(pkgOf(root, "a.ts")).toBe(root);
  });
});

describe("matchesFilter and isExcluded", () => {
  test("brace globs", () => {
    const filter = { on: "**/*.{ts,tsx}", exclude: [] };

    expect(matchesFilter(filter, "src/a.ts")).toBe(true);
    expect(matchesFilter(filter, "src/a.tsx")).toBe(true);
    expect(matchesFilter(filter, "src/a.js")).toBe(false);
  });

  test("** matches the root and nested directories", () => {
    const filter = { on: "**/*.ts", exclude: [] };

    expect(matchesFilter(filter, "a.ts")).toBe(true);
    expect(matchesFilter(filter, "a/b/c/d.ts")).toBe(true);
    expect(matchesFilter({ on: "apps/site/**", exclude: [] }, "apps/site/src/x.svelte")).toBe(true);
    expect(matchesFilter({ on: "apps/site/**", exclude: [] }, "apps/web/x.svelte")).toBe(false);
  });

  test("exclude wins over on", () => {
    const filter = { on: "**/*.ts", exclude: ["**/node_modules/**", "dist/**"] };

    expect(matchesFilter(filter, "node_modules/x/a.ts")).toBe(false);
    expect(matchesFilter(filter, "pkg/node_modules/x/a.ts")).toBe(false);
    expect(matchesFilter(filter, "dist/a.ts")).toBe(false);
    expect(matchesFilter(filter, "src/a.ts")).toBe(true);
  });

  test("isExcluded", () => {
    expect(isExcluded(["a/**", "b/*.{ts,js}"], "b/x.js")).toBe(true);
    expect(isExcluded(["a/**"], "c/x.ts")).toBe(false);
    expect(isExcluded([], "x")).toBe(false);
  });
});
