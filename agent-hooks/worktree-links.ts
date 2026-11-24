import { lstatSync, readFileSync, realpathSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";

import { gitOutput, isDirectory, underCheckout } from "./checkout.ts";
import type { Deadline } from "./core/util/exec.ts";
import { isRecord, isStringArray, parseJsonc, recordField } from "./core/util/json.ts";
import { GitError, gitSync } from "./lib/platform/git.ts";
import { isErrno, messageOf } from "./lib/platform/pure.ts";

/** The main checkout's project settings, where the desktop app reads a worktree session's settings. */
const SETTINGS_FILES = [".claude/settings.json", ".claude/settings.local.json"] as const;

const SETTING = "worktree.symlinkDirectories";

const WORKTREE_LINE = "worktree ";

/**
 * Links into the linked worktree at `checkout` each directory its main checkout declares in Claude Code's
 * `worktree.symlinkDirectories` and holds, as `--worktree` and `EnterWorktree` do: the desktop app's Code tab does
 * not apply the setting to the worktree it creates. A path the worktree already holds is kept, one whose parent it
 * lacks is left out, and one git would not ignore as a link is not linked. Returns a note for the user when a
 * declared directory was not linked for a reason the user can fix, else null. Never throws.
 */
export function linkDeclaredDirectories(checkout: string, deadline: Deadline): string | null {
  try {
    const unignored = linkInto(checkout, deadline);

    return unignored.length === 0 ? null : unignoredNote(checkout, unignored);
  } catch (error) {
    return `agent-hooks: declared directories not all linked into ${checkout}: ${messageOf(error)}`;
  }
}

/** Links each declared directory it can; returns those left unlinked because git would list the link. */
function linkInto(checkout: string, deadline: Deadline): string[] {
  const main = mainCheckoutOf(checkout, deadline);

  if (main === null) {
    return [];
  }

  const candidates = declaredDirectories(main).filter(
    (relative) =>
      isDirectory(path.join(main, relative)) &&
      lstatSync(path.join(checkout, relative), { throwIfNoEntry: false }) === undefined &&
      isDirectory(path.dirname(path.join(checkout, relative))),
  );

  if (candidates.length === 0) {
    return [];
  }

  const ignored = ignoredAsLinks(checkout, candidates, deadline);

  for (const relative of candidates.filter((candidate) => ignored.has(candidate))) {
    linkUnlessPresent(path.join(main, relative), path.join(checkout, relative));
  }

  return candidates.filter((candidate) => !ignored.has(candidate));
}

/** A session starting beside this one in the same worktree may have linked the path first: its link is kept. */
export function linkUnlessPresent(target: string, link: string): void {
  try {
    // Windows creates a junction without privileges, a directory symlink only with them; elsewhere the type is ignored.
    symlinkSync(target, link, "junction");
  } catch (error) {
    if (!isErrno(error, "EEXIST")) {
      throw error;
    }
  }
}

/**
 * The main checkout of the repository `checkout` is a linked worktree of, or null when `checkout` is a main checkout
 * or its repository is bare. A main checkout's `.git` is a directory, which spares it a git process; a submodule's
 * is a file, and git names the submodule itself as its main checkout.
 */
function mainCheckoutOf(checkout: string, deadline: Deadline): string | null {
  if (!statSync(path.join(checkout, ".git")).isFile()) {
    return null;
  }

  const records = gitOutput(checkout, ["worktree", "list", "--porcelain", "-z"], deadline).split(
    "\0",
  );

  const end = records.indexOf("");
  const first = end === -1 ? records : records.slice(0, end);
  const [line = "", ...attributes] = first;

  if (!line.startsWith(WORKTREE_LINE) || attributes.includes("bare")) {
    return null;
  }

  const main = realpathSync.native(line.slice(WORKTREE_LINE.length));

  return main === checkout ? null : main;
}

/**
 * The directories the main checkout's settings declare, relative to its top with `/` as git writes paths, each once,
 * in the files' order.
 */
function declaredDirectories(main: string): string[] {
  return [
    ...new Set(SETTINGS_FILES.flatMap((relative) => declaredIn(main, path.join(main, relative)))),
  ];
}

function declaredIn(main: string, file: string): string[] {
  let source: string;

  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return [];
    }

    throw error;
  }

  let settings: unknown;

  try {
    settings = parseJsonc(source);
  } catch (error) {
    throw new Error(`${file}: invalid JSON: ${messageOf(error)}`, { cause: error });
  }

  if (!isRecord(settings)) {
    throw new Error(`${file}: expected an object`);
  }

  const declared = recordField(settings, "worktree")?.["symlinkDirectories"];

  if (declared === undefined) {
    return [];
  }

  if (!isStringArray(declared)) {
    throw new Error(`${file}: ${SETTING}: expected an array of directory paths`);
  }

  return declared.map((entry) => {
    const relative = underCheckout(main, path.resolve(main, entry));

    if (relative === null) {
      throw new Error(
        `${file}: ${SETTING}: ${JSON.stringify(entry)} is not a directory path inside the repository`,
      );
    }

    return relative.split(path.sep).join("/");
  });
}

/**
 * Which of `paths`, none of them on disk, git would ignore as a link: `--no-index` reads the patterns alone, and git
 * takes a path missing from disk for a file, which a link is to git.
 */
function ignoredAsLinks(
  checkout: string,
  paths: readonly string[],
  deadline: Deadline,
): ReadonlySet<string> {
  const args = ["check-ignore", "--no-index", "--stdin", "-z"];

  const result = gitSync(args, {
    cwd: checkout,
    stdin: paths.map((relative) => `${relative}\0`).join(""),
    timeoutMs: deadline.remaining(),
    scrubGitEnv: true,
  });

  // check-ignore exits 1 when it ignores none of the paths.
  if (result.kind === "exited" && (result.code === 0 || result.code === 1)) {
    return new Set(result.stdout.split("\0").filter((ignored) => ignored !== ""));
  }

  throw new GitError(args, result);
}

function unignoredNote(checkout: string, unignored: readonly string[]): string {
  const patterns = [...new Set(unignored.map((relative) => path.posix.basename(relative)))];

  return `agent-hooks: not linked into ${checkout}: ${unignored.join(", ")}. git would list each link as untracked: ignore it with a pattern without a trailing slash (${patterns.join(", ")}), since to git a link is a file and a pattern with the slash matches only a directory.`;
}
