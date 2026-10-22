import { lstatSync, readFileSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";

import type { Listing, Unreadable } from "./listing.ts";
import { codeOf, listed, throughLink } from "./listing.ts";
import type { Manifest, Repo, Stated, Unread } from "./manifests.ts";
import { isGoMain, kindOf, stated } from "./manifests.ts";
import type { Edge, Env, Imports } from "./scan.ts";
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
// tree, honouring its root .gitignore (listing.ts), reads no file through a link, and reads each
// file once, keeping none of their text.

/** A file larger than this is counted, never read. */
export const FILE_BYTES = 256 * 1024;

/** The code files read for imports, environment variables and Go's main packages, in path order. */
export const SCANNED_AT_MOST = 20_000;

export type Counted = {
  readonly files: number;
  readonly languages: Readonly<Record<string, number>>;
};

export type Dir = Counted & { readonly path: string };

export type Skipped = {
  /** Files the inventory would read, larger than FILE_BYTES. */
  readonly tooLarge: readonly string[];
  /** Links, and files under a folder that is a link: never read. */
  readonly links: readonly string[];
  /** Paths that could not be listed or read, with the system's error code. */
  readonly unreadable: readonly Unreadable[];
  /** Code files past SCANNED_AT_MOST, counted only. */
  readonly unscanned: number;
};

export type Inventory = Counted & {
  readonly root: string;
  readonly listing: Listing;
  readonly warnings: readonly string[];
  readonly limits: { readonly fileBytes: number; readonly scannedFiles: number };
  readonly dirs: readonly Dir[];
  readonly manifests: readonly Manifest[];
  readonly imports: Imports;
  readonly env: Env;
  readonly skipped: Skipped;
};

/** What `inventory --summary` prints: the inventory less what a first read does not need. */
export type Summary = Counted & {
  readonly root: string;
  readonly listing: Listing;
  readonly warnings: readonly string[];
  /** The directories of the top level alone. */
  readonly dirs: readonly { readonly path: string; readonly files: number }[];
  readonly manifests: readonly Manifest[];
  readonly imports: readonly Edge[];
  /** The names of the environment variables read, without their files. */
  readonly env: readonly string[];
  readonly skipped: {
    readonly tooLarge: number;
    readonly links: number;
    readonly unreadable: number;
    readonly unscanned: number;
  };
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

type Read =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "too large" }
  | { readonly kind: "link" }
  | { readonly kind: "unreadable"; readonly code: string };

type Reader = {
  /** A file's text, or why it gives none; the text is the caller's, never kept here. */
  readonly read: (path: string) => Read;
  /** The paths read gave no text for, by reason, each once. */
  readonly skipped: () => Pick<Skipped, "tooLarge" | "links" | "unreadable">;
};

function readerOf(root: string): Reader {
  const tooLarge = new Set<string>();
  const links = new Set<string>();
  const unreadable = new Map<string, string>();
  const linkedDirs = new Map<string, boolean>();

  const read = (path: string): Read => {
    const file = join(root, path);

    try {
      if (throughLink(root, path, linkedDirs)) {
        links.add(path);

        return { kind: "link" };
      }

      if (lstatSync(file).size > FILE_BYTES) {
        tooLarge.add(path);

        return { kind: "too large" };
      }

      return { kind: "text", text: readFileSync(file, "utf8") };
    } catch (error: unknown) {
      unreadable.set(path, codeOf(error));

      return { kind: "unreadable", code: codeOf(error) };
    }
  };

  const skipped = (): Pick<Skipped, "tooLarge" | "links" | "unreadable"> => ({
    tooLarge: [...tooLarge],
    links: [...links],
    unreadable: [...unreadable].map(([path, code]) => ({ path, code })),
  });

  return { read, skipped };
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

const unreadText = (got: Exclude<Read, { readonly kind: "text" }>): Unread => ({
  unread: got.kind === "unreadable" ? `unreadable (${got.code})` : got.kind,
});

export function inventoryOf(dir: string, scannedAtMost = SCANNED_AT_MOST): Inventory {
  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) {
    throw new InventoryError(`${dir} is not a folder`);
  }

  const root = resolve(dir);
  const { listing, files, links, unreadable, warnings } = listed(root);
  const { read, skipped } = readerOf(root);
  const fileSet = new Set(files);
  const goMains = new Set<string>();
  const repo: Repo = { files: fileSet, goMains };

  const state = (path: string): Stated[] => {
    const kind = kindOf(path);

    if (kind === null) return [];
    const got = read(path);
    const one = stated(kind, path, got.kind === "text" ? got.text : unreadText(got), repo);

    return one === null ? [] : [one];
  };

  // go.mod's entries are the main packages the pass over the code finds: it is stated after it.
  const early = files.filter((path) => kindOf(path) !== "go.mod").flatMap((path) => state(path));

  const packages = new Map(
    early.flatMap(({ manifest }) =>
      manifest.kind === "package.json" && "name" in manifest && manifest.name !== null
        ? [[manifest.name, posix.dirname(manifest.path)] as const]
        : [],
    ),
  );

  const tree = { files: fileSet, dirs: dirsOf(files), packages, modules: pythonModules(fileSet) };
  const scannable = files.filter((path) => isScanned(path));
  const scanned = scannable.slice(0, scannedAtMost);
  const pairs: (readonly [string, string])[] = [];
  const reads: (readonly [string, string])[] = [];

  for (const path of scanned) {
    const got = read(path);

    if (got.kind !== "text") continue;
    const from = fileUnit(path);

    for (const to of importsOf(tree, path, got.text)) pairs.push([from, to]);

    for (const name of envOf(path, got.text)) reads.push([name, path]);

    if (path.endsWith(".go") && isGoMain(got.text)) goMains.add(posix.dirname(path));
  }

  const stateds = [
    ...early,
    ...files.filter((path) => kindOf(path) === "go.mod").flatMap((path) => state(path)),
  ];

  const unread = skipped();

  return {
    root,
    listing,
    warnings,
    limits: { fileBytes: FILE_BYTES, scannedFiles: scannedAtMost },
    ...counted(files),
    dirs: dirsIn(files),
    manifests: stateds
      .map(({ manifest }) => manifest)
      .toSorted((a, b) => byText(a.path, b.path) || byText(a.kind, b.kind)),
    imports: { note: IMPORTS_NOTE, edges: edgesOf(pairs) },
    env: {
      note: ENV_NOTE,
      vars: varsOf([
        ...stateds.flatMap(({ manifest, env }) =>
          env.map((name) => [name, manifest.path] as const),
        ),
        ...reads,
      ]),
    },
    skipped: {
      tooLarge: unread.tooLarge.toSorted(),
      links: [...links, ...unread.links].toSorted(),
      unreadable: [...unreadable, ...unread.unreadable].toSorted((a, b) => byText(a.path, b.path)),
      unscanned: scannable.length - scanned.length,
    },
  };
}

export function summaryOf(inventory: Inventory): Summary {
  const { root, listing, warnings, files, languages, manifests, skipped } = inventory;

  return {
    root,
    listing,
    warnings,
    files,
    languages,
    dirs: inventory.dirs.flatMap((d) =>
      d.path.includes("/") ? [] : [{ path: d.path, files: d.files }],
    ),
    manifests,
    imports: inventory.imports.edges,
    env: inventory.env.vars.map((v) => v.name),
    skipped: {
      tooLarge: skipped.tooLarge.length,
      links: skipped.links.length,
      unreadable: skipped.unreadable.length,
      unscanned: skipped.unscanned,
    },
  };
}
