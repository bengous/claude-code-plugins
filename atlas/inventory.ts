import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, posix } from "node:path";

import type { Manifest, Repo } from "./manifests.ts";
import { kindOf, stated } from "./manifests.ts";
import type { Env, Imports } from "./scan.ts";
import {
  ENV_NOTE,
  IMPORTS_NOTE,
  byText,
  dirsOf,
  edgesOf,
  envOf,
  fileUnit,
  importsOf,
  isScanned,
  pythonModules,
  varsOf,
} from "./scan.ts";

// What a repository holds, for `cli.ts inventory <repo>`, which prints it as JSON: its manifests and
// the facts they state, its directories of the top two levels, the imports between them and the
// environment variables its code reads. Deterministic and model-free: the same files give the same
// output. It lists the files git lists, .gitignore applied, or walks the folder outside a git work
// tree, and reads no file outside the folder.

/** A file larger than this is counted, never read. */
export const FILE_BYTES = 256 * 1024;

/** The code files read for imports and environment variables, in path order; the rest are counted. */
export const SCANNED_AT_MOST = 20_000;

/** The folders a walk outside git never enters. */
const WALK_SKIPS = new Set([".git", "node_modules"]);

export type Listing = "git" | "walk";

export type Counted = {
  readonly files: number;
  readonly languages: Readonly<Record<string, number>>;
};

export type Dir = Counted & { readonly path: string };

export type Skipped = {
  /** Files the inventory would read, larger than FILE_BYTES. */
  readonly tooLarge: readonly string[];
  /** Links, and files whose real path leaves the folder: never read. */
  readonly links: readonly string[];
  /** Code files past SCANNED_AT_MOST, counted only. */
  readonly unscanned: number;
};

export type Inventory = Counted & {
  readonly root: string;
  readonly listing: Listing;
  readonly limits: { readonly fileBytes: number; readonly scannedFiles: number };
  readonly dirs: readonly Dir[];
  readonly manifests: readonly Manifest[];
  readonly imports: Imports;
  readonly env: Env;
  readonly skipped: Skipped;
};

export class InventoryError extends Error {}

/** Each language with the file extensions, or the whole file names, that mark its files. */
const LANGUAGE_MARKS = [
  ["TypeScript", [".ts", ".tsx", ".mts", ".cts"]],
  ["JavaScript", [".js", ".jsx", ".mjs", ".cjs"]],
  ["Python", [".py"]],
  ["Go", [".go"]],
  ["Rust", [".rs"]],
  ["Java", [".java"]],
  ["Kotlin", [".kt"]],
  ["Ruby", [".rb"]],
  ["PHP", [".php"]],
  ["C#", [".cs"]],
  ["C", [".c", ".h"]],
  ["C++", [".cc", ".cpp", ".hpp"]],
  ["Swift", [".swift"]],
  ["Lua", [".lua"]],
  ["Shell", [".sh", ".bash", ".zsh", ".fish"]],
  ["Nix", [".nix"]],
  ["SQL", [".sql"]],
  ["HTML", [".html"]],
  ["CSS", [".css", ".scss"]],
  ["Vue", [".vue"]],
  ["Svelte", [".svelte"]],
  ["Markdown", [".md", ".mdx"]],
  ["JSON", [".json", ".jsonc"]],
  ["YAML", [".yml", ".yaml"]],
  ["TOML", [".toml"]],
  ["Dockerfile", ["Dockerfile", "Containerfile"]],
  ["Make", ["Makefile"]],
  ["Just", ["Justfile", "justfile"]],
] as const;

const LANGUAGES = new Map<string, string>(
  LANGUAGE_MARKS.flatMap(([language, marks]) => marks.map((mark) => [mark, language] as const)),
);

export function languageOf(path: string): string {
  const name = posix.basename(path);

  return LANGUAGES.get(name) ?? LANGUAGES.get(posix.extname(name).toLowerCase()) ?? "other";
}

/** git's environment variables point a git elsewhere than the folder, as a hook's GIT_DIR does. */
const gitEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) =>
      key.startsWith("GIT_") || value === undefined ? [] : [[key, value]],
    ),
  );

/** The paths git lists in `root`, tracked or untracked but not ignored; `null` outside a work tree. */
function gitPaths(root: string): string[] | null {
  const argv = ["git", "-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"];

  const listed = (() => {
    try {
      const run = Bun.spawnSync(argv, { env: gitEnv(), stdout: "pipe", stderr: "pipe" });

      return run.exitCode === 0 ? run.stdout.toString() : null;
    } catch {
      // No git on the PATH (ENOENT): the folder is walked, which the output's `listing` says.
      return null;
    }
  })();

  return listed === null ? null : [...new Set(listed.split("\0").filter((path) => path !== ""))];
}

const walkPaths = (root: string, sub = ""): string[] =>
  readdirSync(join(root, sub), { withFileTypes: true }).flatMap((entry) => {
    const path = sub === "" ? entry.name : `${sub}/${entry.name}`;

    if (entry.isDirectory()) return WALK_SKIPS.has(entry.name) ? [] : walkPaths(root, path);

    return entry.isFile() || entry.isSymbolicLink() ? [path] : [];
  });

type Listed = {
  readonly listing: Listing;
  readonly files: readonly string[];
  readonly links: readonly string[];
};

function list(root: string): Listed {
  const fromGit = gitPaths(root);
  const paths = (fromGit ?? walkPaths(root)).toSorted();
  const files: string[] = [];
  const links: string[] = [];

  for (const path of paths) {
    const entry = lstatSync(join(root, path), { throwIfNoEntry: false });

    if (entry?.isSymbolicLink() === true) links.push(path);
    else if (entry?.isFile() === true) files.push(path);
  }

  return { listing: fromGit === null ? "walk" : "git", files, links };
}

type Unread = "too large" | "outside the folder";

type Read = { readonly text: string } | { readonly unread: Unread };

type Reader = {
  readonly read: (path: string) => Read;
  /** The paths read asked for and got no text of, for `reason`. */
  readonly unread: (reason: Unread) => string[];
};

/** Reads a file of the folder once, and keeps the paths it would not read, by reason. */
function readerOf(root: string): Reader {
  const cache = new Map<string, Read>();

  const read = (path: string): Read => {
    const known = cache.get(path);

    if (known !== undefined) return known;
    const file = join(root, path);
    let got: Read;

    if (!realpathSync(file).startsWith(`${root}/`)) got = { unread: "outside the folder" };
    else if (lstatSync(file).size > FILE_BYTES) got = { unread: "too large" };
    else got = { text: readFileSync(file, "utf8") };

    cache.set(path, got);

    return got;
  };

  const unread = (reason: Unread): string[] =>
    [...cache].flatMap(([path, got]) => ("unread" in got && got.unread === reason ? [path] : []));

  return { read, unread };
}

function counted(files: readonly string[]): Counted {
  const languages = new Map<string, number>();

  for (const file of files) {
    const language = languageOf(file);
    languages.set(language, (languages.get(language) ?? 0) + 1);
  }

  return {
    files: files.length,
    languages: Object.fromEntries([...languages].toSorted(([a], [b]) => byText(a, b))),
  };
}

/** The directories of the top two levels, each with the files under it at any depth. */
function dirsIn(files: readonly string[]): Dir[] {
  const under = new Map<string, string[]>();

  for (const file of files) {
    const segments = posix.dirname(file).split("/");

    if (segments[0] === ".") continue;

    for (const depth of [1, 2].filter((d) => d <= segments.length)) {
      const dir = segments.slice(0, depth).join("/");
      const inside = under.get(dir) ?? [];
      inside.push(file);
      under.set(dir, inside);
    }
  }

  // By segment, so that each directory comes right before the ones inside it.
  return [...under]
    .toSorted(([a], [b]) => byText(a.replaceAll("/", "\0"), b.replaceAll("/", "\0")))
    .map(([path, inside]) => ({ path, ...counted(inside) }));
}

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

/** The width under which a value is printed on one line. */
const WIDTH = 100;

/** JSON indented as JSON.stringify(…, null, 2) indents it, but a value that fits WIDTH holds one line. */
export function printed(value: Json, indent = ""): string {
  const flat = JSON.stringify(value);

  if (indent.length + flat.length <= WIDTH || !(value instanceof Object)) return flat;
  const inner = `${indent}  `;

  const lines = Array.isArray(value)
    ? value.map((item) => `${inner}${printed(item, inner)}`)
    : Object.entries(value).map(
        ([key, item]) => `${inner}${JSON.stringify(key)}: ${printed(item, inner)}`,
      );

  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];

  return `${open}\n${lines.join(",\n")}\n${indent}${close}`;
}

export function inventoryOf(dir: string): Inventory {
  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) {
    throw new InventoryError(`${dir} is not a folder`);
  }

  const root = realpathSync(dir);
  const { listing, files, links } = list(root);
  const { read, unread } = readerOf(root);

  const textOf = (path: string): string | null => {
    const got = read(path);

    return "text" in got ? got.text : null;
  };

  const fileSet = new Set(files);
  const repo: Repo = { files: fileSet, read: textOf };

  const stateds = files.flatMap((path) => {
    const kind = kindOf(path);

    if (kind === null) return [];
    const got = read(path);

    return stated(kind, path, "text" in got ? got.text : got, repo) ?? [];
  });

  const manifests = stateds.map(({ manifest }) => manifest);

  const packages = new Map(
    manifests.flatMap((manifest) =>
      manifest.kind === "package.json" && "name" in manifest && manifest.name !== null
        ? [[manifest.name, posix.dirname(manifest.path)] as const]
        : [],
    ),
  );

  const tree = { files: fileSet, dirs: dirsOf(files), packages, modules: pythonModules(fileSet) };
  const scannable = files.filter((path) => isScanned(path));
  const scanned = scannable.slice(0, SCANNED_AT_MOST);
  const pairs: (readonly [string, string])[] = [];

  const reads: (readonly [string, string])[] = stateds.flatMap(({ manifest, env }) =>
    env.map((name) => [name, manifest.path] as const),
  );

  for (const path of scanned) {
    const text = textOf(path);

    if (text === null) continue;
    const from = fileUnit(path);

    for (const to of importsOf(tree, path, text)) pairs.push([from, to]);

    for (const name of envOf(path, text)) reads.push([name, path]);
  }

  return {
    root,
    listing,
    limits: { fileBytes: FILE_BYTES, scannedFiles: SCANNED_AT_MOST },
    ...counted(files),
    dirs: dirsIn(files),
    manifests: manifests.toSorted((a, b) => byText(a.path, b.path) || byText(a.kind, b.kind)),
    imports: { note: IMPORTS_NOTE, edges: edgesOf(pairs) },
    env: { note: ENV_NOTE, vars: varsOf(reads) },
    skipped: {
      tooLarge: unread("too large").toSorted(),
      links: [...links, ...unread("outside the folder")].toSorted(),
      unscanned: scannable.length - scanned.length,
    },
  };
}
