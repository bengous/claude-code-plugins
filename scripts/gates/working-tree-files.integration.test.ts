import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import { workingTreeFiles } from "./working-tree-files.ts";

describe("workingTreeFiles", () => {
  let repo = "";

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "working-tree-files-"));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("lists tracked and untracked files, and leaves ignored ones out", async () => {
    await $`git init -q`.cwd(repo).quiet();
    mkdirSync(join(repo, "plugin"));
    writeFileSync(join(repo, "tracked.sh"), "");
    writeFileSync(join(repo, "plugin", "new.md"), "");
    writeFileSync(join(repo, ".gitignore"), "ignored.sh\n");
    writeFileSync(join(repo, "ignored.sh"), "");
    await $`git add tracked.sh`.cwd(repo).quiet();

    expect((await workingTreeFiles(repo)).toSorted()).toEqual([
      ".gitignore",
      "plugin/new.md",
      "tracked.sh",
    ]);
  });
});
