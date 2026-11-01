import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";

import { gitSync } from "../platform/git.ts";
import { errnoOf, isErrno } from "../platform/pure.ts";

// The files of a repository, for inventory.ts: the ones git lists, .gitignore applied, or outside a
// git work tree a walk that honours the root's .gitignore. A path that cannot be listed or looked
// at (a loop of links, a name the system cannot decode, a folder it may not read) is set aside with
// its error code, never thrown: one bad path leaves the rest of the inventory whole.

export type Listing = "git" | "walk";

export type Unreadable = { readonly path: string; readonly code: string };

export type Listed = {
  readonly listing: Listing;
  readonly files: readonly string[];
  readonly links: readonly string[];
  readonly unreadable: readonly Unreadable[];
  readonly warnings: readonly string[];
};

/** The folders a walk outside git never enters. */
const WALK_SKIPS = new Set([".git", "node_modules"]);

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- it reads what a catch clause caught, which TypeScript types unknown: anything can be thrown.
export const codeOf = (error: unknown): string => errnoOf(error) ?? String(error);

/**
 * The paths git lists in `root`, tracked or untracked but not ignored; `null` outside a work tree.
 * git's environment variables are left out: they point a git elsewhere than the folder, as a
 * hook's GIT_DIR does.
 */
function gitPaths(root: string): string[] | null {
  const out = (() => {
    try {
      const run = gitSync(
        ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        { scrubGitEnv: true, config: ["core.fsmonitor=false"], stdout: "buffer" },
      );

      return run.kind === "exited" && run.code === 0 ? run.stdout.toString() : null;
    } catch {
      // No git on the PATH (gitSync throws): the folder is walked, which the output's `listing` says.
      return null;
    }
  })();

  return out === null ? null : [...new Set(out.split("\0").filter((path) => path !== ""))];
}

type Rule = { readonly pattern: RegExp; readonly negated: boolean; readonly dirOnly: boolean };

const globPart = (glob: string): string =>
  glob
    .split(/(\*\*\/|\/\*\*|\*\*|\*|\?)/u)
    .map((piece) => {
      switch (piece) {
        case "**/":
          return "(?:.*/)?";
        case "/**":
          return "(?:/.*)?";
        case "**":
          return ".*";
        case "*":
          return "[^/]*";
        case "?":
          return "[^/]";
        default:
          return piece.replaceAll(/[.+^${}()|[\]\\]/gu, "\\$&");
      }
    })
    .join("");

/**
 * The rules of a .gitignore, in its simple forms: `name` anywhere, `/name` and `a/b` from the
 * root, `dir/` for folders alone, `*`, `?` and `**`, and `!` taking a path back. A later rule wins.
 */
export function ignoreRules(text: string): Rule[] {
  return text.split("\n").flatMap((raw): Rule[] => {
    const line = raw.trim();

    if (line === "" || line.startsWith("#")) return [];
    const negated = line.startsWith("!");
    const body = negated ? line.slice(1) : line;
    const dirOnly = body.endsWith("/");
    const glob = dirOnly ? body.slice(0, -1) : body;
    const anchored = glob.includes("/");
    const source = globPart(glob.replace(/^\//u, ""));

    return [
      {
        pattern: new RegExp(anchored ? `^${source}$` : `(?:^|/)${source}$`, "u"),
        negated,
        dirOnly,
      },
    ];
  });
}

/** Whether the last rule that matches `path` ignores it. */
export function isIgnored(rules: readonly Rule[], path: string, isDir: boolean): boolean {
  let ignored = false;

  for (const rule of rules) {
    if ((!rule.dirOnly || isDir) && rule.pattern.test(path)) ignored = !rule.negated;
  }

  return ignored;
}

function walkPaths(root: string, unreadable: Unreadable[]): string[] {
  const paths: string[] = [];
  let rules: Rule[] = [];

  try {
    rules = ignoreRules(readFileSync(join(root, ".gitignore"), "utf8"));
  } catch (error: unknown) {
    if (!isErrno(error, "ENOENT")) unreadable.push({ path: ".gitignore", code: codeOf(error) });
  }

  const walk = (sub: string): void => {
    let entries;

    try {
      entries = readdirSync(join(root, sub), { withFileTypes: true });
    } catch (error: unknown) {
      unreadable.push({ path: sub, code: codeOf(error) });

      return;
    }

    for (const entry of entries) {
      const path = sub === "" ? entry.name : `${sub}/${entry.name}`;

      if (entry.isDirectory()) {
        if (!WALK_SKIPS.has(entry.name) && !isIgnored(rules, path, true)) walk(path);
      } else if ((entry.isFile() || entry.isSymbolicLink()) && !isIgnored(rules, path, false)) {
        paths.push(path);
      }
    }
  };

  walk("");

  return paths;
}

const holdsAnything = (root: string): boolean => {
  try {
    return readdirSync(root).some((name) => name !== ".git");
  } catch {
    return false;
  }
};

const EMPTY_UNDER_GIT =
  "git lists no file in this folder, which holds some: an enclosing repository may ignore it, or its core.worktree may point elsewhere";

export function listed(root: string): Listed {
  const unreadable: Unreadable[] = [];
  const fromGit = gitPaths(root);
  const paths = (fromGit ?? walkPaths(root, unreadable)).toSorted();
  const files: string[] = [];
  const links: string[] = [];

  for (const path of paths) {
    try {
      const entry = lstatSync(join(root, path), { throwIfNoEntry: false });

      if (entry?.isSymbolicLink() === true) links.push(path);
      else if (entry?.isFile() === true) files.push(path);
    } catch (error: unknown) {
      unreadable.push({ path, code: codeOf(error) });
    }
  }

  const empty = fromGit !== null && paths.length === 0 && holdsAnything(root);

  return {
    listing: fromGit === null ? "walk" : "git",
    files,
    links,
    unreadable: unreadable.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    warnings: empty ? [EMPTY_UNDER_GIT] : [],
  };
}

/** Whether a folder on the way from `root` to `path` is a link, which leads out of the folder. */
export function throughLink(root: string, path: string, known: Map<string, boolean>): boolean {
  for (let dir = posix.dirname(path); dir !== "."; dir = posix.dirname(dir)) {
    let linked = known.get(dir);

    if (linked === undefined) {
      linked = lstatSync(join(root, dir)).isSymbolicLink();
      known.set(dir, linked);
    }

    if (linked) return true;
  }

  return false;
}
