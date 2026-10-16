import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { CONFIG_RELATIVE_PATH } from "./config.ts";
import type { Photo } from "./state.ts";

export const WORKTREES_PREFIX = ".claude/worktrees/";

export const DELETED = "deleted";

/** The nearest ancestor of `start` (itself included) that holds `.claude/agent-hooks.jsonc`. */
export function findRoot(start: string): string | null {
  let dir = path.resolve(start);

  for (;;) {
    if (existsSync(path.join(dir, CONFIG_RELATIVE_PATH))) {
      return dir;
    }

    const parent = path.dirname(dir);

    if (parent === dir) {
      return null;
    }

    dir = parent;
  }
}

function git(root: string, args: readonly string[]): string | null {
  // Without an explicit env Bun.spawnSync reuses the process's original environ and ignores the GIT_* scrub of tests.
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  return proc.exitCode === 0 ? proc.stdout.toString() : null;
}

export function headSha(root: string): string | null {
  return git(root, ["rev-parse", "--verify", "HEAD"])?.trim() ?? null;
}

/**
 * The dirty and untracked paths of the checkout, relative to `root`, in git's order. `-uall` lists every file of a
 * new directory instead of the directory alone. `null` when git fails or prints an entry the parser cannot read.
 */
export function dirtyPaths(root: string): string[] | null {
  const output = git(root, ["status", "--porcelain=v1", "-z", "-uall"]);
  const toplevel = git(root, ["rev-parse", "--show-toplevel"])?.trim();

  if (output === null || toplevel === undefined) {
    return null;
  }

  const parsed = parseGitStatus(output);

  if (parsed === null) {
    return null;
  }

  return relativeToRoot(parsed, toplevel, root);
}

function relativeToRoot(paths: readonly string[], toplevel: string, root: string): string[] {
  const resolvedRoot = path.resolve(root);

  if (path.resolve(toplevel) === resolvedRoot) {
    return [...paths];
  }

  return paths.flatMap((entry) => {
    const relative = path.relative(resolvedRoot, path.join(toplevel, entry));

    return relative.startsWith("..") || path.isAbsolute(relative) ? [] : [relative];
  });
}

export function parseGitStatus(output: string): string[] | null {
  const entries = output.split("\0");
  const paths: string[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (entry === undefined || entry === "") {
      continue;
    }

    if (entry.length < 4 || entry[2] !== " ") {
      return null;
    }

    const status = entry.slice(0, 2);

    if (status === "!!") {
      continue;
    }

    paths.push(entry.slice(3));

    // A rename or a copy prints the source path in the next NUL record.
    if (status.includes("R") || status.includes("C")) {
      index += 1;
      const original = entries[index];

      if (original === undefined || original === "") {
        return null;
      }

      paths.push(original);
    }
  }

  return paths;
}

export function hashFile(absolutePath: string): string {
  try {
    return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
  } catch {
    return DELETED;
  }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function takePhoto(root: string, now = Date.now()): Photo | null {
  const paths = dirtyPaths(root);

  if (paths === null) {
    return null;
  }

  const files: Record<string, string> = {};

  for (const relativePath of paths) {
    files[relativePath] = hashFile(path.join(root, relativePath));
  }

  return { head: headSha(root), files, takenAt: now };
}

/**
 * The dirty paths whose content differs from the photo, sorted, minus the worktrees. A file the session deleted
 * stays in: a `project` lane must run on a deletion, and a `files` lane or a fixer takes only the files on disk.
 */
export function sessionFiles(root: string, photo: Photo): string[] | null {
  const paths = dirtyPaths(root);

  if (paths === null) {
    return null;
  }

  return [...new Set(paths)]
    .filter((relativePath) => !relativePath.startsWith(WORKTREES_PREFIX))
    .filter((relativePath) => photo.files[relativePath] !== hashFile(path.join(root, relativePath)))
    .toSorted();
}

/** Every dirty path, sorted, minus the worktrees; deleted files included, as in `sessionFiles`. */
export function wholeDirtyTree(root: string): string[] | null {
  const paths = dirtyPaths(root);

  if (paths === null) {
    return null;
  }

  return [...new Set(paths)]
    .filter((relativePath) => !relativePath.startsWith(WORKTREES_PREFIX))
    .toSorted();
}

/** The scope files still on disk: what a fixer can rewrite. */
export function onDisk(root: string, scope: readonly string[]): string[] {
  return scope.filter((relativePath) => existsSync(path.join(root, relativePath)));
}

/** One line per dirty path with its content hash: the part of the green key that tracks the uncommitted tree. */
export function dirtyDigest(root: string): string {
  const paths = dirtyPaths(root) ?? [];

  return sha256(
    [...new Set(paths)]
      .toSorted()
      .map((relativePath) => `${relativePath}:${hashFile(path.join(root, relativePath))}`)
      .join("\n"),
  );
}
