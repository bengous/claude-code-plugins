import { readdirSync } from "node:fs";
import { sep } from "node:path";

import { GitError, GitMissingError, gitRead } from "../../../lib/platform/git.ts";
import { globMatch } from "./glob.ts";

const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".venv",
  "venv",
  "node_modules",
  "__pycache__",
  ".tox",
  ".mypy_cache",
  "build",
  "dist",
  "out",
  ".next",
  ".nuxt",
  "coverage",
  ".turbo",
  ".svelte-kit",
]);

/** Line count as an editor shows it: a last line without its newline still counts. */
export function lineCount(source: string): number {
  if (source === "") return 0;

  const newlines = source.split("\n").length - 1;

  return source.endsWith("\n") ? newlines : newlines + 1;
}

async function tracked(root: string): Promise<string[] | null> {
  try {
    const out = await gitRead(["ls-files", "-z"], { cwd: root, raw: true });

    return out.split("\0").filter((path) => path !== "");
  } catch (error) {
    if (error instanceof GitError || error instanceof GitMissingError) return null;
    throw error;
  }
}

function walked(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .map((path) => path.split(sep).join("/"))
    .filter((path) => !path.split("/").some((part) => SKIP_DIRS.has(part)));
}

/**
 * The files under `root` that `keep` accepts, relative to it with `/` separators, sorted.
 * Asks git for its tracked files when `useGit` and `root` is in a repository, so a tracked folder
 * named `build/` stays; walks the directory otherwise, skipping dependency and build folders.
 */
export async function listFiles(
  root: string,
  useGit: boolean,
  keep: (path: string) => boolean,
  exclude: readonly string[],
): Promise<string[]> {
  const all = (useGit ? await tracked(root) : null) ?? walked(root);

  return all
    .filter((path) => keep(path) && !exclude.some((pattern) => globMatch(pattern, path)))
    .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
