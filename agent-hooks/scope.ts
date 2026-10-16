import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { CONFIG_RELATIVE_PATH } from "./config.ts";
import type { Photo } from "./state.ts";

export const WORKTREES_PREFIX = ".claude/worktrees/";

export const DELETED = "deleted";

/** The directory pre-edit writes its scratch copy into, beside the real file, for the time its fixers run. */
export const SCRATCH_PREFIX = ".agent-hooks-";

/** A scratch directory's name: the prefix and the six characters `mkdtemp` appends, nothing else. */
const SCRATCH_NAME = /^\.agent-hooks-[0-9A-Za-z]{6}$/u;

const UNTRACKED = "??";

/**
 * `absolute` as a path relative to `root`, or null for the root itself and for a path outside it. `..` counts only
 * as a whole segment: `..config.ts` lies inside the root.
 */
export function underRoot(root: string, absolute: string): string | null {
  const relative = path.relative(path.resolve(root), path.resolve(absolute));

  return relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
    ? null
    : relative;
}

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

/** One record of `git status --porcelain`: its two status letters and its path. */
export type StatusEntry = { readonly status: string; readonly path: string };

/**
 * The dirty and untracked entries of the checkout, their paths relative to `root`, in git's order, scratch copies
 * included. `-uall` lists every file of a new directory instead of the directory alone. `null` when git fails or
 * prints an entry the parser cannot read.
 */
function statusEntries(root: string): StatusEntry[] | null {
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
  return (
    statusEntries(root)
      ?.map((entry) => entry.path)
      .filter((relativePath) => scratchDirOf(relativePath) === null) ?? null
  );
}

/** The pre-edit scratch directory a path lies in, or null for a path of the checkout's own. */
function scratchDirOf(relativePath: string): string | null {
  const segments = relativePath.split("/");
  const index = segments.findIndex((segment) => SCRATCH_NAME.test(segment));

  return index === -1 ? null : segments.slice(0, index + 1).join("/");
}

/**
 * The scratch directories a pre-edit killed while its fixers ran left behind: untracked, named as `mkdtemp` names
 * them, holding no tracked file, and last changed more than `olderThanMs` ago, a pre-edit's own living at most its
 * deadline.
 */
export function staleScratchDirs(root: string, olderThanMs: number, now = Date.now()): string[] {
  const dirs = new Set(
    (statusEntries(root) ?? []).flatMap((entry) =>
      entry.status === UNTRACKED ? (scratchDirOf(entry.path) ?? []) : [],
    ),
  );

  return [...dirs]
    .filter((dir) => isStaleDirectory(path.join(root, dir), olderThanMs, now))
    .filter((dir) => git(root, ["ls-files", "--", dir])?.trim() === "")
    .toSorted();
}

function isStaleDirectory(absolute: string, olderThanMs: number, now: number): boolean {
  try {
    const stats = statSync(absolute);

    return stats.isDirectory() && stats.mtimeMs < now - olderThanMs;
  } catch {
    return false;
  }
}

function relativeToRoot(
  entries: readonly StatusEntry[],
  toplevel: string,
  root: string,
): StatusEntry[] {
  const resolvedRoot = path.resolve(root);

  if (path.resolve(toplevel) === resolvedRoot) {
    return [...entries];
  }

  return entries.flatMap((entry) => {
    const relativePath = underRoot(resolvedRoot, path.join(toplevel, entry.path));

    return relativePath === null ? [] : [{ status: entry.status, path: relativePath }];
  });
}

export function parseGitStatus(output: string): StatusEntry[] | null {
  const entries = output.split("\0");
  const parsed: StatusEntry[] = [];

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

    parsed.push({ status, path: entry.slice(3) });

    // A rename or a copy prints the source path in the next NUL record.
    if (status.includes("R") || status.includes("C")) {
      index += 1;
      const original = entries[index];

      if (original === undefined || original === "") {
        return null;
      }

      parsed.push({ status, path: original });
    }
  }

  return parsed;
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
