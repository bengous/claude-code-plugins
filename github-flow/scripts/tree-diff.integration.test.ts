import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import { type Change, parseNameStatus, treeDiff } from "./tree-diff.ts";

const SCRIPT = join(import.meta.dir, "tree-diff.ts");

function tree(changes: Change[], base: string[], head: string[]): string[] {
  return treeDiff({ changes, baseFiles: new Set(base), headFiles: new Set(head) });
}

describe("parseNameStatus", () => {
  test("reads each status, renames and copies with their source", () => {
    const raw = "M\0a.ts\0R087\0old/x.ts\0new/x.ts\0A\0b.ts\0D\0c.ts\0C100\0d.ts\0e.ts\0T\0f\0";

    expect(parseNameStatus(raw)).toEqual([
      { kind: "modified", path: "a.ts" },
      { kind: "renamed", from: "old/x.ts", path: "new/x.ts" },
      { kind: "added", path: "b.ts" },
      { kind: "deleted", path: "c.ts" },
      { kind: "copied", from: "d.ts", path: "e.ts" },
      { kind: "modified", path: "f" },
    ]);
  });

  test("an empty diff is no change", () => {
    expect(parseNameStatus("")).toEqual([]);
  });

  test("an unknown status fails with its code", () => {
    expect(() => parseNameStatus("X\0a.ts\0")).toThrow("unknown name-status code: X");
  });

  test("a rename cut short fails", () => {
    expect(() => parseNameStatus("R100\0old.ts\0")).toThrow("truncated");
  });
});

describe("treeDiff", () => {
  test("a directory moved whole is one line, named at its most precise level", () => {
    const lines = tree(
      [
        { kind: "renamed", from: "data/pages/a.json", path: "archive/data/pages/a.json" },
        { kind: "renamed", from: "data/pages/b.json", path: "archive/data/pages/b.json" },
        { kind: "modified", path: "data/tree.json" },
      ],
      ["data/pages/a.json", "data/pages/b.json", "data/tree.json"],
      ["archive/data/pages/a.json", "archive/data/pages/b.json", "data/tree.json"],
    );

    expect(lines).toEqual([
      "+archive/data/pages/  ← data/pages/ (2 files)",
      " data/",
      " └── tree.json",
    ]);
  });

  test("a partial move counts what left the source", () => {
    const lines = tree(
      [
        { kind: "renamed", from: "scripts/a.ts", path: "archive/scripts/a.ts" },
        { kind: "renamed", from: "scripts/b.ts", path: "archive/scripts/b.ts" },
      ],
      ["scripts/a.ts", "scripts/b.ts", "scripts/keep.ts"],
      ["archive/scripts/a.ts", "archive/scripts/b.ts", "scripts/keep.ts"],
    );

    expect(lines).toEqual(["+archive/scripts/  ← scripts/ (2 of 3 files)"]);
  });

  test("a directory renamed in place folds under its parent", () => {
    const lines = tree(
      [
        { kind: "renamed", from: "src/utils/a.ts", path: "src/helpers/a.ts" },
        { kind: "renamed", from: "src/utils/b.ts", path: "src/helpers/b.ts" },
      ],
      ["src/utils/a.ts", "src/utils/b.ts", "src/main.ts"],
      ["src/helpers/a.ts", "src/helpers/b.ts", "src/main.ts"],
    );

    expect(lines).toEqual([" src/", "+└── helpers/  ← src/utils/ (2 files)"]);
  });

  test("moves from several sources stay apart under a new directory", () => {
    const lines = tree(
      [
        { kind: "renamed", from: "data/pages/a.json", path: "archive/data/pages/a.json" },
        { kind: "renamed", from: "scripts/merge.ts", path: "archive/scripts/merge.ts" },
      ],
      ["data/pages/a.json", "scripts/merge.ts", "scripts/keep.ts"],
      ["archive/data/pages/a.json", "archive/scripts/merge.ts", "scripts/keep.ts"],
    );

    expect(lines).toEqual([
      "+archive/",
      "+├── data/pages/  ← data/pages/ (1 file)",
      "+└── scripts/  ← scripts/ (1 of 2 files)",
    ]);
  });

  test("a directory added whole and one deleted whole are one line each", () => {
    const lines = tree(
      [
        { kind: "added", path: "docs/a.md" },
        { kind: "added", path: "docs/b.md" },
        { kind: "deleted", path: "old/x.ts" },
        { kind: "deleted", path: "old/y.ts" },
      ],
      ["old/x.ts", "old/y.ts"],
      ["docs/a.md", "docs/b.md"],
    );

    expect(lines).toEqual(["+docs/  (2 files)", "-old/  (2 files)"]);
  });

  test("an open directory lists its changed files with tree glyphs, directories first", () => {
    const lines = tree(
      [
        { kind: "modified", path: "src/a.ts" },
        { kind: "deleted", path: "src/b.ts" },
        { kind: "added", path: "src/lib/d.ts" },
      ],
      ["src/a.ts", "src/b.ts", "src/lib/c.ts"],
      ["src/a.ts", "src/lib/c.ts", "src/lib/d.ts"],
    );

    expect(lines).toEqual([" src/", " ├── lib/", "+│   └── d.ts", " ├── a.ts", "-└── b.ts"]);
  });

  test("a file renamed in its directory names the old file only", () => {
    const lines = tree(
      [
        { kind: "renamed", from: "src/old.ts", path: "src/new.ts" },
        { kind: "renamed", from: "a.md", path: "b.md" },
      ],
      ["src/old.ts", "src/x.ts", "a.md"],
      ["src/new.ts", "src/x.ts", "b.md"],
    );

    expect(lines).toEqual([" src/", "+└── new.ts  ← old.ts", "+b.md  ← a.md"]);
  });

  test("copies count with renames when a directory folds", () => {
    const lines = tree(
      [
        { kind: "copied", from: "lib/io.ts", path: "archive/lib/io.ts" },
        { kind: "renamed", from: "lib/merge.ts", path: "archive/lib/merge.ts" },
      ],
      ["lib/io.ts", "lib/merge.ts", "lib/keep.ts"],
      ["lib/io.ts", "lib/keep.ts", "archive/lib/io.ts", "archive/lib/merge.ts"],
    );

    expect(lines).toEqual(["+archive/lib/  ← lib/ (2 of 3 files, 1 copied)"]);
  });

  test("a directory of copies says so: its source did not move", () => {
    const lines = tree(
      [
        { kind: "copied", from: "lib/a.ts", path: "vendor/lib/a.ts" },
        { kind: "copied", from: "lib/b.ts", path: "vendor/lib/b.ts" },
      ],
      ["lib/a.ts", "lib/b.ts"],
      ["lib/a.ts", "lib/b.ts", "vendor/lib/a.ts", "vendor/lib/b.ts"],
    );

    expect(lines).toEqual(["+vendor/lib/  ← lib/ (2 files, 2 copied)"]);
  });

  test("a file replaced by a directory of the same name shows both", () => {
    expect(
      tree(
        [
          { kind: "deleted", path: "foo" },
          { kind: "added", path: "foo/bar.ts" },
        ],
        ["foo"],
        ["foo/bar.ts"],
      ),
    ).toEqual(["+foo/  (1 file)", "-foo"]);

    expect(
      tree(
        [
          { kind: "deleted", path: "foo/bar.ts" },
          { kind: "added", path: "foo" },
        ],
        ["foo/bar.ts"],
        ["foo"],
      ),
    ).toEqual(["-foo/  (1 file)", "+foo"]);
  });

  test("past three modified files at the root, the count names the root", () => {
    const modified = ["a.ts", "b.ts", "c.ts", "d.ts"];

    const lines = tree(
      modified.map((path): Change => ({ kind: "modified", path })),
      modified,
      modified,
    );

    expect(lines).toEqual([" (4 files modified at the root)"]);
  });

  test("past three modified files, a directory shows their count", () => {
    const modified = ["a", "b", "c", "d", "e"].map((name) => `src/${name}.ts`);

    const lines = tree(
      [
        ...modified.map((path): Change => ({ kind: "modified", path })),
        { kind: "added", path: "src/new.ts" },
      ],
      modified,
      [...modified, "src/new.ts"],
    );

    expect(lines).toEqual([" src/", "+├── new.ts", " └── (5 files modified)"]);
  });

  test("a directory where files were only modified folds past three", () => {
    const modified = ["pkg/x/a.ts", "pkg/x/b.ts", "pkg/y/c.ts", "pkg/d.ts"];

    const lines = tree(
      modified.map((path): Change => ({ kind: "modified", path })),
      modified,
      modified,
    );

    expect(lines).toEqual([" pkg/  (4 files modified)"]);
  });

  test("a directory filled from the root lists its files: the root is not a source", () => {
    const lines = tree(
      [
        { kind: "renamed", from: "a.ts", path: "pkg/a.ts" },
        { kind: "copied", from: "b.ts", path: "pkg/b.ts" },
      ],
      ["a.ts", "b.ts"],
      ["pkg/a.ts", "pkg/b.ts", "b.ts"],
    );

    expect(lines).toEqual(["+pkg/", "+├── a.ts  ← a.ts", "+└── b.ts  ← copy of b.ts"]);
  });
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  const { stderr, exitCode } = await $`git ${args}`.cwd(cwd).quiet().nothrow();

  if (exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${stderr.toString().trim()}`);
}

describe("tree-diff.ts on a repository", () => {
  let tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs = [];
  });

  const MOVE_TREE = ["+archive/pages/  ← data/pages/ (2 files)", " web/src/", " └── app.ts"].join(
    "\n",
  );

  /** A repository whose branch `move` moves `data/pages/` whole and edits `web/src/app.ts`. */
  async function makeMoveRepo(): Promise<string> {
    const repo = mkdtempSync(join(tmpdir(), "tree-diff-"));
    tmpDirs.push(repo);
    await git(repo, "init", "--quiet", "--initial-branch=main");
    await git(repo, "config", "user.email", "test@test.com");
    await git(repo, "config", "user.name", "Test");
    await git(repo, "config", "commit.gpgsign", "false");
    await mkdir(join(repo, "data", "pages"), { recursive: true });
    await mkdir(join(repo, "web", "src"), { recursive: true });
    await Bun.write(join(repo, "data", "pages", "a.txt"), "page a\n");
    await Bun.write(join(repo, "data", "pages", "b.txt"), "page b\n");
    await Bun.write(join(repo, "data", "keep.txt"), "kept\n");
    await Bun.write(join(repo, "web", "src", "app.ts"), "export {};\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "--quiet", "-m", "base");
    await git(repo, "switch", "--quiet", "-c", "move");
    await mkdir(join(repo, "archive"), { recursive: true });
    await git(repo, "mv", "data/pages", "archive/pages");
    await Bun.write(join(repo, "web", "src", "app.ts"), "export const app = 1;\n");
    await git(repo, "commit", "--quiet", "--all", "-m", "move");

    return repo;
  }

  test("a branch that moves a directory whole prints it as one line", async () => {
    const repo = await makeMoveRepo();

    const { stdout, exitCode } = await $`bun ${SCRIPT} main`.cwd(repo).quiet().nothrow();

    expect(exitCode).toBe(0);
    expect(stdout.toString().trim()).toBe(MOVE_TREE);
  });

  test("run from a subdirectory, the tree is the same", async () => {
    const repo = await makeMoveRepo();

    const { stdout, exitCode } = await $`bun ${SCRIPT} main`
      .cwd(join(repo, "web"))
      .quiet()
      .nothrow();

    expect(exitCode).toBe(0);
    expect(stdout.toString().trim()).toBe(MOVE_TREE);
  });

  test("no base prints the usage and exits 2", async () => {
    const { stderr, exitCode } = await $`bun ${SCRIPT}`.quiet().nothrow();

    expect(exitCode).toBe(2);
    expect(stderr.toString()).toContain("Usage: tree-diff.ts <base>");
  });
});
