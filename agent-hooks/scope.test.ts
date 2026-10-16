import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CONFIG_RELATIVE_PATH } from "./config.ts";
import {
  DELETED,
  dirtyDigest,
  findRoot,
  parseGitStatus,
  sessionFiles,
  sha256,
  takePhoto,
  wholeDirtyTree,
} from "./scope.ts";
import type { TempRepo } from "./test-support.ts";
import {
  createTempRepo,
  git,
  removeTempRepo,
  scrubGitEnv,
  writeConfig,
  writeRepoFile,
} from "./test-support.ts";

const temps: TempRepo[] = [];

const plainDirs: string[] = [];

beforeEach(() => {
  scrubGitEnv();
});

afterEach(() => {
  for (const temp of temps.splice(0)) {
    removeTempRepo(temp);
  }

  for (const dir of plainDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const TWO_FILES = { "a.txt": "a1\n", "b.txt": "b1\n" };

function repoWith(files: Readonly<Record<string, string>> = TWO_FILES): string {
  const temp = createTempRepo("agent-hooks-scope-", files);
  temps.push(temp);

  return temp.repo;
}

function plainDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-hooks-scope-plain-"));
  plainDirs.push(dir);

  return dir;
}

function remove(repo: string, name: string): void {
  rmSync(path.join(repo, name));
}

function photoOf(repo: string): NonNullable<ReturnType<typeof takePhoto>> {
  const photo = takePhoto(repo);

  if (photo === null) {
    throw new Error("takePhoto returned null");
  }

  return photo;
}

describe("findRoot", () => {
  test("from a nested dir of a repo that holds the config", () => {
    const repo = repoWith();
    writeConfig(repo, "{}");
    const nested = path.join(repo, "a", "b");
    mkdirSync(nested, { recursive: true });

    expect(findRoot(nested)).toBe(repo);
    expect(findRoot(repo)).toBe(repo);
  });

  test("from a nested dir of a worktree that holds its own config", () => {
    const repo = repoWith();
    writeConfig(repo, "{}");
    const worktree = path.join(repo, ".claude", "worktrees", "w");
    writeRepoFile(worktree, CONFIG_RELATIVE_PATH, "{}");
    const nested = path.join(worktree, "src", "deep");
    mkdirSync(nested, { recursive: true });

    expect(findRoot(nested)).toBe(worktree);
  });

  test("null when no ancestor holds the config", () => {
    const nested = path.join(plainDir(), "a", "b");
    mkdirSync(nested, { recursive: true });

    expect(findRoot(nested)).toBeNull();
  });
});

describe("parseGitStatus", () => {
  test("keeps modified, untracked and both paths of a rename, skips ignored", () => {
    expect(parseGitStatus(" M a\0?? b\0R  new\0old\0!! ignored\0")).toEqual([
      "a",
      "b",
      "new",
      "old",
    ]);
  });

  test("keeps both paths of a copy", () => {
    expect(parseGitStatus("C  copy\0source\0")).toEqual(["copy", "source"]);
  });

  test("an empty output has no paths", () => {
    expect(parseGitStatus("")).toEqual([]);
  });

  test("an entry without the space at index 2 is null", () => {
    expect(parseGitStatus("MMXa\0")).toBeNull();
  });

  test("a rename with no following record is null", () => {
    expect(parseGitStatus("R  new\0")).toBeNull();
    expect(parseGitStatus("R  new")).toBeNull();
  });
});

describe("takePhoto", () => {
  test("a committed and clean tree has no files and the commit as head", () => {
    const repo = repoWith();
    const photo = photoOf(repo);

    expect(photo.files).toEqual({});
    expect(photo.head).toBe(git(repo, "rev-parse", "HEAD").trim());
  });

  test("a modified file is hashed", () => {
    const repo = repoWith();
    writeRepoFile(repo, "a.txt", "a2\n");

    expect(photoOf(repo).files).toEqual({ "a.txt": sha256("a2\n") });
  });

  test("a new file in a new directory is listed by its path", () => {
    const repo = repoWith();
    writeRepoFile(repo, "newdir/deep/x.txt", "x\n");

    expect(photoOf(repo).files).toEqual({ "newdir/deep/x.txt": sha256("x\n") });
  });

  test("a renamed file lists both paths, the old one as deleted", () => {
    const repo = repoWith();
    git(repo, "mv", "a.txt", "renamed.txt");

    expect(photoOf(repo).files).toEqual({ "renamed.txt": sha256("a1\n"), "a.txt": DELETED });
  });

  test("a deleted tracked file is deleted", () => {
    const repo = repoWith();
    remove(repo, "b.txt");

    expect(photoOf(repo).files).toEqual({ "b.txt": DELETED });
  });

  test("a repo with no commit has a null head", () => {
    const repo = repoWith({});
    writeRepoFile(repo, "x.txt", "x\n");
    const photo = photoOf(repo);

    expect(photo.head).toBeNull();
    expect(photo.files).toEqual({ "x.txt": sha256("x\n") });
  });

  test("null outside a git repo", () => {
    expect(takePhoto(plainDir())).toBeNull();
  });
});

describe("sessionFiles", () => {
  test("a file created or modified after the photo is in scope", () => {
    const repo = repoWith();
    const photo = photoOf(repo);
    writeRepoFile(repo, "a.txt", "a2\n");
    writeRepoFile(repo, "c.txt", "c\n");

    expect(sessionFiles(repo, photo)).toEqual(["a.txt", "c.txt"]);
  });

  test("a file already dirty at the photo and untouched since is not in scope", () => {
    const repo = repoWith();
    writeRepoFile(repo, "a.txt", "a2\n");
    writeRepoFile(repo, "c.txt", "c\n");
    const photo = photoOf(repo);

    expect(sessionFiles(repo, photo)).toEqual([]);
  });

  test("a file dirty at the photo, then committed, is not in scope", () => {
    const repo = repoWith();
    writeRepoFile(repo, "a.txt", "a2\n");
    const photo = photoOf(repo);
    git(repo, "commit", "-qam", "commit a");

    expect(sessionFiles(repo, photo)).toEqual([]);
  });

  test("a file modified at the photo, then modified again, is in scope", () => {
    const repo = repoWith();
    writeRepoFile(repo, "a.txt", "a2\n");
    const photo = photoOf(repo);
    writeRepoFile(repo, "a.txt", "a3\n");

    expect(sessionFiles(repo, photo)).toEqual(["a.txt"]);
  });

  test("a tracked file deleted after the photo is in scope; an untracked one is gone from git", () => {
    const repo = repoWith();
    writeRepoFile(repo, "a.txt", "a2\n");
    writeRepoFile(repo, "c.txt", "c\n");
    const photo = photoOf(repo);
    remove(repo, "a.txt");
    remove(repo, "c.txt");

    expect(sessionFiles(repo, photo)).toEqual(["a.txt"]);
  });

  test("a file deleted before the photo and still deleted is not in scope", () => {
    const repo = repoWith();
    remove(repo, "a.txt");
    const photo = photoOf(repo);

    expect(sessionFiles(repo, photo)).toEqual([]);
  });

  test("a file renamed after the photo puts both paths in scope", () => {
    const repo = repoWith();
    const photo = photoOf(repo);
    git(repo, "mv", "a.txt", "renamed.txt");

    expect(sessionFiles(repo, photo)).toEqual(["a.txt", "renamed.txt"]);
  });

  test("a file under .claude/worktrees/x/ created after the photo is not in scope", () => {
    const repo = repoWith();
    const photo = photoOf(repo);
    writeRepoFile(repo, ".claude/worktrees/x/f.txt", "f\n");

    expect(sessionFiles(repo, photo)).toEqual([]);
  });

  test("a photo taken on a clean tree, then two new files: both, sorted", () => {
    const repo = repoWith();
    const photo = photoOf(repo);
    writeRepoFile(repo, "z.txt", "z\n");
    writeRepoFile(repo, "dir/m.txt", "m\n");

    expect(sessionFiles(repo, photo)).toEqual(["dir/m.txt", "z.txt"]);
  });

  test("a file whose content is restored to the photo's content is not in scope", () => {
    const repo = repoWith();
    writeRepoFile(repo, "a.txt", "a2\n");
    const photo = photoOf(repo);
    writeRepoFile(repo, "a.txt", "a3\n");
    writeRepoFile(repo, "a.txt", "a2\n");

    expect(sessionFiles(repo, photo)).toEqual([]);
  });

  test("an ignored file is never in scope", () => {
    const repo = repoWith({ ".gitignore": "*.log\n", "a.txt": "a1\n" });
    const photo = photoOf(repo);
    writeRepoFile(repo, "debug.log", "noise\n");
    writeRepoFile(repo, "dir/other.log", "noise\n");

    expect(sessionFiles(repo, photo)).toEqual([]);
  });

  test("null when git status fails (not a git repo)", () => {
    const photo = photoOf(repoWith());

    expect(sessionFiles(plainDir(), photo)).toBeNull();
  });
});

describe("wholeDirtyTree", () => {
  test("every dirty path minus the worktrees, the deleted files included", () => {
    const repo = repoWith();
    writeRepoFile(repo, "a.txt", "a2\n");
    writeRepoFile(repo, "c.txt", "c\n");
    remove(repo, "b.txt");
    writeRepoFile(repo, ".claude/worktrees/x/f.txt", "f\n");

    expect(wholeDirtyTree(repo)).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  test("null outside a git repo", () => {
    expect(wholeDirtyTree(plainDir())).toBeNull();
  });
});

describe("dirtyDigest", () => {
  test("the same tree twice gives the same digest", () => {
    const repo = repoWith();
    writeRepoFile(repo, "a.txt", "a2\n");

    expect(dirtyDigest(repo)).toBe(dirtyDigest(repo));
  });

  test("a modified file changes the digest", () => {
    const repo = repoWith();
    writeRepoFile(repo, "a.txt", "a2\n");
    const before = dirtyDigest(repo);
    writeRepoFile(repo, "a.txt", "a3\n");

    expect(dirtyDigest(repo)).not.toBe(before);
  });

  test("a new untracked file changes the digest", () => {
    const repo = repoWith();
    const before = dirtyDigest(repo);
    writeRepoFile(repo, "c.txt", "c\n");

    expect(dirtyDigest(repo)).not.toBe(before);
  });
});
