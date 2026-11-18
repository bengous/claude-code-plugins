import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { CONFIG_RELATIVE_PATH } from "./config.ts";
import type { Deadline } from "./core/util/exec.ts";
import { DELETED, hashFile, sha256 } from "./core/util/hash.ts";
import { GitError, gitSync } from "./lib/platform/git.ts";
import { isInsideRelative } from "./lib/platform/pure.ts";

/** Claude Code's agent worktrees, nested in the checkout: each is a checkout of its own. */
const WORKTREES_PREFIX = ".claude/worktrees/";

/** The directory pre-edit writes its scratch copy into, beside the real file, for the time its fixers run. */
export const SCRATCH_PREFIX = ".agent-hooks-";

/** A scratch directory's name: the prefix and the six characters `mkdtemp` appends, nothing else. */
const SCRATCH_NAME = /^\.agent-hooks-[0-9A-Za-z]{6}$/u;

const UNTRACKED = "??";

/** A checkout that opted in: its top directory and its config file. */
export type Place = { readonly checkout: string; readonly configFile: string };

/** A checkout's baseline: its dirty tree when the agent first reached it. */
export type Photo = {
  readonly head: string | null;
  /** Checkout-relative path to the sha256 of its content, or "deleted" when the path is gone from disk. */
  readonly files: Record<string, string>;
  readonly takenAt: number;
};

/** The dirty paths of a checkout, each to the hash of its content. */
export type DirtyTree = ReadonlyMap<string, string>;

/** `dir`, or its nearest ancestor on disk. */
export function nearestDirectory(dir: string): string {
  return existsSync(dir) ? dir : nearestDirectory(path.dirname(dir));
}

/**
 * `target` as an absolute path with the symlinks of its directories resolved, so a path from a payload names the
 * file git names. A file's own link is kept, as git keeps it; the part of the path not yet on disk is kept as given.
 */
export function realPathOf(target: string): string {
  const resolved = path.resolve(target);
  const existing = nearestDirectory(isDirectory(resolved) ? resolved : path.dirname(resolved));

  return path.join(realpathSync.native(existing), path.relative(existing, resolved));
}

function isDirectory(absolute: string): boolean {
  try {
    return statSync(absolute).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The top of the git checkout holding `start`, the directory `git rev-parse --show-toplevel` names: the nearest
 * ancestor holding a `.git` entry, a directory or a worktree's file. Found without starting git, so a repository
 * that did not opt in costs a hook no process.
 */
export function checkoutOf(start: string): string | null {
  let dir = nearestDirectory(path.resolve(start));

  for (;;) {
    if (existsSync(path.join(dir, ".git"))) {
      return dir;
    }

    const parent = path.dirname(dir);

    if (parent === dir) {
      return null;
    }

    dir = parent;
  }
}

/** The checkout holding `start` when it holds `.claude/agent-hooks.jsonc` at its top, else null. */
export function placeOf(start: string): Place | null {
  const checkout = checkoutOf(start);

  if (checkout === null) {
    return null;
  }

  const configFile = path.join(checkout, CONFIG_RELATIVE_PATH);

  return existsSync(configFile) ? { checkout, configFile } : null;
}

/**
 * `absolute` as a path relative to `checkout`, or null for the checkout itself and for a path outside it. `..`
 * counts only as a whole segment: `..config.ts` lies inside.
 */
export function underCheckout(checkout: string, absolute: string): string | null {
  const relative = path.relative(path.resolve(checkout), path.resolve(absolute));

  return relative === "" || !isInsideRelative(relative, [path.sep]) ? null : relative;
}

/**
 * Runs git in `cwd` under what is left of the deadline, without the `GIT_*` variables of the caller: a `GIT_DIR`
 * would send git to another repository than the checkout `checkoutOf` found. A git that fails or times out throws a `GitError` that says
 * which: no caller may read it as "no changes".
 */
function gitOutput(cwd: string, args: readonly string[], deadline: Deadline): string {
  const result = gitSync(args, { cwd, timeoutMs: deadline.remaining(), scrubGitEnv: true });

  if (result.kind === "exited" && result.code === 0) {
    return result.stdout;
  }

  throw new GitError(args, result);
}

/** The commit HEAD names, or null in a repository with no commit yet. */
export function headSha(checkout: string, deadline: Deadline): string | null {
  const args = ["rev-parse", "--verify", "--quiet", "HEAD"];

  const result = gitSync(args, {
    cwd: checkout,
    timeoutMs: deadline.remaining(),
    scrubGitEnv: true,
  });

  if (result.kind === "exited" && result.code === 0) {
    return result.stdout.trim();
  }

  if (result.kind === "exited" && result.code === 1) {
    return null;
  }

  throw new GitError(args, result);
}

/** One record of `git status --porcelain`: its two status letters and its path, relative to the checkout. */
type StatusEntry = { readonly status: string; readonly path: string };

/**
 * The dirty and untracked entries of the checkout, in git's order, scratch copies included. `-uall` lists every
 * file of a new directory instead of the directory alone.
 */
function statusEntries(checkout: string, deadline: Deadline): StatusEntry[] {
  const output = gitOutput(checkout, ["status", "--porcelain=v1", "-z", "-uall"], deadline);
  const entries = parseGitStatus(output);

  if (entries === null) {
    throw new Error(`git status in ${checkout} printed a record the kit cannot read`);
  }

  return entries;
}

export function parseGitStatus(output: string): StatusEntry[] | null {
  const records = output.split("\0");
  const parsed: StatusEntry[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];

    if (record === undefined || record === "") {
      continue;
    }

    if (record.length < 4 || record[2] !== " ") {
      return null;
    }

    const status = record.slice(0, 2);
    parsed.push({ status, path: record.slice(3) });

    // A rename or a copy prints the source path in the next NUL record.
    if (status.includes("R") || status.includes("C")) {
      index += 1;
      const original = records[index];

      if (original === undefined || original === "") {
        return null;
      }

      parsed.push({ status, path: original });
    }
  }

  return parsed;
}

/** The pre-edit scratch directory a path lies in, or null for a path of the checkout's own. */
function scratchDirOf(relativePath: string): string | null {
  const segments = relativePath.split("/");
  const index = segments.findIndex((segment) => SCRATCH_NAME.test(segment));

  return index === -1 ? null : segments.slice(0, index + 1).join("/");
}

/**
 * The dirty paths of the checkout to their content hash, minus the scratch copies a concurrent pre-edit holds and
 * minus a nested repository, which git lists as its directory, `nested/`: its files are its own checkout's.
 */
export function dirtyTree(checkout: string, deadline: Deadline): DirtyTree {
  return new Map(
    statusEntries(checkout, deadline)
      .map((entry) => entry.path)
      .filter((relativePath) => scratchDirOf(relativePath) === null && !relativePath.endsWith("/"))
      .map((relativePath) => [relativePath, hashFile(path.join(checkout, relativePath))]),
  );
}

export function takePhoto(checkout: string, deadline: Deadline, now = Date.now()): Photo {
  return {
    head: headSha(checkout, deadline),
    files: Object.fromEntries(dirtyTree(checkout, deadline)),
    takenAt: now,
  };
}

/**
 * The dirty paths whose content differs from the photo, sorted, minus the nested worktrees. A file the session
 * deleted stays in: a `project` lane must run on a deletion, and a `files` lane or a fixer takes only the files on
 * disk.
 */
export function sessionFiles(tree: DirtyTree, photo: Photo): string[] {
  return [...tree]
    .flatMap(([relativePath, hash]) => (photo.files[relativePath] === hash ? [] : [relativePath]))
    .filter((relativePath) => !relativePath.startsWith(WORKTREES_PREFIX))
    .toSorted();
}

/** Every dirty path, sorted, minus the nested worktrees; deleted files included, as in `sessionFiles`. */
export function wholeDirtyTree(tree: DirtyTree): string[] {
  return [...tree.keys()]
    .filter((relativePath) => !relativePath.startsWith(WORKTREES_PREFIX))
    .toSorted();
}

/** The tree with `files` read again from disk: what the Stop fixers left, without another `git status`. */
export function rehashed(tree: DirtyTree, checkout: string, files: readonly string[]): DirtyTree {
  const next = new Map(tree);

  for (const relativePath of files) {
    next.set(relativePath, hashFile(path.join(checkout, relativePath)));
  }

  return next;
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

/** The tracked files of the checkout, sorted. */
export function trackedFiles(checkout: string, deadline: Deadline): string[] {
  return gitOutput(checkout, ["ls-files", "-z"], deadline)
    .split("\0")
    .filter((relativePath) => relativePath !== "")
    .toSorted();
}

/**
 * The scratch directories a pre-edit killed while its fixers ran left behind: untracked, named as `mkdtemp` names
 * them, holding no tracked file, and last changed more than `olderThanMs` ago, a pre-edit's own living at most its
 * deadline.
 */
export function staleScratchDirs(
  checkout: string,
  olderThanMs: number,
  deadline: Deadline,
  now = Date.now(),
): string[] {
  const dirs = new Set(
    statusEntries(checkout, deadline).flatMap((entry) =>
      entry.status === UNTRACKED ? (scratchDirOf(entry.path) ?? []) : [],
    ),
  );

  return [...dirs]
    .filter((dir) => isStaleDirectory(path.join(checkout, dir), olderThanMs, now))
    .filter((dir) => gitOutput(checkout, ["ls-files", "--", dir], deadline).trim() === "")
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
