import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { CONFIG_RELATIVE_PATH } from "./config.ts";
import type { Photo } from "./state.ts";

export const WORKTREES_PREFIX = ".claude/worktrees/";

export const DELETED = "deleted";

/** The directory pre-edit writes its scratch copy into, beside the real file, for the time its fixers run. */
export const SCRATCH_PREFIX = ".agent-hooks-";

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
 * The dirty and untracked paths of the checkout, relative to `root`, in git's order, scratch copies included.
 * `-uall` lists every file of a new directory instead of the directory alone. `null` when git fails or prints an
 * entry the parser cannot read.
 */
function statusPaths(root: string): string[] | null {
  const output = git(root, ["status", "--porcelain=v1", "-z", "-uall"]);
  const toplevel = git(root, ["rev-parse", "--show-toplevel"])?.trim();

  if (output === null || toplevel === undefined) {
    return null;
  }

  const parsed = parseGitStatus(output);

  return parsed === null ? null : relativeToRoot(parsed, toplevel, root);
}

/** The dirty and untracked paths of the checkout, minus the scratch copies a concurrent pre-edit holds. */
export function dirtyPaths(root: string): string[] | null {
  return statusPaths(root)?.filter((relativePath) => scratchDirOf(relativePath) === null) ?? null;
}

/** The pre-edit scratch directory a path lies in, or null for a path of the checkout's own. */
function scratchDirOf(relativePath: string): string | null {
  const segments = relativePath.split("/");
  const index = segments.findIndex((segment) => segment.startsWith(SCRATCH_PREFIX));

  return index === -1 ? null : segments.slice(0, index + 1).join("/");
}

/**
 * The scratch directories git lists as untracked whose last change is older than `olderThanMs`: a pre-edit's
 * own lives at most its deadline, so an older one was left by a pre-edit killed while its fixers ran.
 */
export function staleScratchDirs(root: string, olderThanMs: number, now = Date.now()): string[] {
  const dirs = new Set(
    (statusPaths(root) ?? []).flatMap((relativePath) => scratchDirOf(relativePath) ?? []),
  );

  return [...dirs]
    .filter((dir) => {
      try {
        return statSync(path.join(root, dir)).mtimeMs < now - olderThanMs;
      } catch {
        return false;
      }
    })
    .toSorted();
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

/** The dirty paths of a checkout, each to the hash of its content: one `git status` and one read of each file. */
export type DirtyTree = ReadonlyMap<string, string>;

export function dirtyTree(root: string): DirtyTree | null {
  const paths = dirtyPaths(root);

  if (paths === null) {
    return null;
  }

  return new Map(
    paths.map((relativePath) => [relativePath, hashFile(path.join(root, relativePath))]),
  );
}

/** The tree with `files` read again from disk: what the Stop fixers left, without another `git status`. */
export function rehashed(tree: DirtyTree, root: string, files: readonly string[]): DirtyTree {
  const next = new Map(tree);

  for (const relativePath of files) {
    next.set(relativePath, hashFile(path.join(root, relativePath)));
  }

  return next;
}

export function takePhoto(root: string, now = Date.now()): Photo | null {
  const tree = dirtyTree(root);

  return tree === null
    ? null
    : { head: headSha(root), files: Object.fromEntries(tree), takenAt: now };
}

/**
 * The dirty paths whose content differs from the photo, sorted, minus the worktrees. A file the session deleted
 * stays in: a `project` lane must run on a deletion, and a `files` lane or a fixer takes only the files on disk.
 */
export function sessionFiles(tree: DirtyTree, photo: Photo): string[] {
  return [...tree]
    .flatMap(([relativePath, hash]) =>
      !relativePath.startsWith(WORKTREES_PREFIX) && photo.files[relativePath] !== hash
        ? [relativePath]
        : [],
    )
    .toSorted();
}

/** Every dirty path, sorted, minus the worktrees; deleted files included, as in `sessionFiles`. */
export function wholeDirtyTree(tree: DirtyTree): string[] {
  return [...tree.keys()]
    .filter((relativePath) => !relativePath.startsWith(WORKTREES_PREFIX))
    .toSorted();
}

/** The scope files still on disk: what a fixer can rewrite. */
export function onDisk(root: string, scope: readonly string[]): string[] {
  return scope.filter((relativePath) => existsSync(path.join(root, relativePath)));
}

/** One line per dirty path with its content hash: the part of the green key that tracks the uncommitted tree. */
export function dirtyDigest(tree: DirtyTree): string {
  return sha256(
    [...tree.keys()]
      .toSorted()
      .map((relativePath) => `${relativePath}:${tree.get(relativePath) ?? DELETED}`)
      .join("\n"),
  );
}
