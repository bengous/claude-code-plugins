#!/usr/bin/env bun

// tree-diff — Backend for the file-tree view of /github-flow:pr.
//
// Prints the files a branch touches as a tree whose lines carry a diff prefix,
// ready for a ```diff block. A directory moved, added or deleted whole is one
// line, and so is a run of modified files, so a branch of a hundred renames
// stays a short tree: the shape of the change, not its file list.

import { $ } from "bun";

const MAX_LISTED_MODIFIED = 3;

export type Change =
  | { kind: "added"; path: string }
  | { kind: "modified"; path: string }
  | { kind: "deleted"; path: string }
  | { kind: "renamed"; from: string; path: string }
  | { kind: "copied"; from: string; path: string };

export type Snapshot = {
  changes: readonly Change[];
  baseFiles: ReadonlySet<string>;
  headFiles: ReadonlySet<string>;
};

type Mark = " " | "+" | "-";

type Line = { mark: Mark; note: string };

type Node = {
  name: string;
  path: string;
  children: Map<string, Node>;
  leaf: Line | null;
};

type Entry =
  | { kind: "line"; name: string; line: Line }
  | { kind: "dir"; name: string; mark: Mark; children: Entry[] };

type Context = {
  byPath: ReadonlyMap<string, Change>;
  baseUnder: ReadonlyMap<string, readonly string[]>;
  headUnder: ReadonlyMap<string, readonly string[]>;
  modifiedCounts: Map<Node, number | null>;
};

const USAGE = `Usage: tree-diff.ts <base>

  <base>   The PR base as a ref, e.g. origin/dev. The tree covers <base>...HEAD:
           the files changed since the merge base, renames and copies detected.`;

/** Parses `git diff --name-status -M -C -z`: a copy keeps its source in place. */
export function parseNameStatus(raw: string): Change[] {
  const fields = raw.split("\0");
  const changes: Change[] = [];
  let index = 0;

  const next = (): string => {
    const field = fields[index];
    index += 1;

    if (field === undefined || field === "")
      throw new Error(`truncated name-status at field ${index}`);

    return field;
  };

  while (index < fields.length && fields[index] !== "") {
    const status = next();
    const code = status.charAt(0);

    switch (code) {
      case "A":
        changes.push({ kind: "added", path: next() });
        break;
      case "M":
      case "T":
        changes.push({ kind: "modified", path: next() });
        break;
      case "D":
        changes.push({ kind: "deleted", path: next() });
        break;
      case "R": {
        const from = next();
        changes.push({ kind: "renamed", from, path: next() });
        break;
      }

      case "C": {
        const from = next();
        changes.push({ kind: "copied", from, path: next() });
        break;
      }

      default:
        throw new Error(`unknown name-status code: ${status}`);
    }
  }

  return changes;
}

function newNode(name: string, path: string): Node {
  return { name, path, children: new Map(), leaf: null };
}

function insert(root: Node, path: string, leaf: Line): void {
  let node = root;

  for (const segment of path.split("/")) {
    const childPath = node.path === "" ? segment : `${node.path}/${segment}`;
    let child = node.children.get(segment);

    if (child === undefined) {
      child = newNode(segment, childPath);
      node.children.set(segment, child);
    }

    node = child;
  }

  node.leaf = leaf;
}

/** Every directory mapped to the files below it, built once: a lookup per directory stays cheap on a large repository. */
function indexByDir(files: Iterable<string>): Map<string, string[]> {
  const index = new Map<string, string[]>();

  for (const file of files) {
    for (let slash = file.indexOf("/"); slash !== -1; slash = file.indexOf("/", slash + 1)) {
      const dir = file.slice(0, slash);
      const below = index.get(dir);

      if (below === undefined) index.set(dir, [file]);
      else below.push(file);
    }
  }

  return index;
}

function under(index: ReadonlyMap<string, readonly string[]>, dir: string): readonly string[] {
  return index.get(dir) ?? [];
}

function countFiles(count: number): string {
  return count === 1 ? "1 file" : `${count} files`;
}

/**
 * The directory `file` came from when its path under `dir` is kept, or null.
 * The repository root is never a source: "moved from ./" names nothing.
 */
function sourceDir(file: string, from: string, dir: string): string | null {
  const relative = file.slice(dir.length + 1);

  if (!from.endsWith(`/${relative}`)) return null;

  return from.slice(0, from.length - relative.length - 1);
}

/**
 * Whether every file under `dir`, at base and at head, sits in one same
 * subdirectory: the fold then belongs to that subdirectory, which names the
 * move more precisely.
 */
function soleSubdir(dir: string, context: Context): boolean {
  const names = new Set<string>();

  for (const file of [...under(context.baseUnder, dir), ...under(context.headUnder, dir)]) {
    const rest = file.slice(dir.length + 1);
    const slash = rest.indexOf("/");

    if (slash === -1) return false;
    names.add(rest.slice(0, slash));
  }

  return names.size === 1;
}

function fold(dir: string, context: Context): Line | null {
  if (soleSubdir(dir, context)) return null;

  const headUnder = under(context.headUnder, dir);
  const baseUnder = under(context.baseUnder, dir);

  if (headUnder.length === 0) {
    const allDeleted =
      baseUnder.length > 0 &&
      baseUnder.every((file) => context.byPath.get(file)?.kind === "deleted");

    return allDeleted ? { mark: "-", note: `(${countFiles(baseUnder.length)})` } : null;
  }

  if (baseUnder.length > 0) return null;

  const incoming = headUnder.map((file) => context.byPath.get(file));

  if (incoming.every((change) => change?.kind === "added")) {
    return { mark: "+", note: `(${countFiles(headUnder.length)})` };
  }

  const sources = new Set<string>();
  let copied = 0;

  for (const change of incoming) {
    if (change?.kind !== "renamed" && change?.kind !== "copied") return null;

    const source = sourceDir(change.path, change.from, dir);

    if (source === null) return null;
    sources.add(source);

    if (change.kind === "copied") copied += 1;
  }

  const [source] = sources;

  if (sources.size !== 1 || source === undefined) return null;

  const total = under(context.baseUnder, source).length;
  const arrived = headUnder.length;
  const count = arrived === total ? countFiles(arrived) : `${arrived} of ${countFiles(total)}`;
  const copies = copied === 0 ? "" : `, ${copied} copied`;

  return { mark: "+", note: `← ${source}/ (${count}${copies})` };
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");

  return slash === -1 ? "" : path.slice(0, slash);
}

function lineFor(change: Change): Line {
  switch (change.kind) {
    case "added":
      return { mark: "+", note: "" };
    case "modified":
      return { mark: " ", note: "" };
    case "deleted":
      return { mark: "-", note: "" };
    case "renamed":
    case "copied": {
      const sameDir = dirOf(change.from) === dirOf(change.path);
      const source = sameDir ? (change.from.split("/").pop() ?? change.from) : change.from;
      const verb = change.kind === "copied" ? "copy of " : "";

      return { mark: "+", note: `← ${verb}${source}` };
    }

    default: {
      const unreachable: never = change;
      throw new Error(`unhandled change: ${JSON.stringify(unreachable)}`);
    }
  }
}

function dirMark(dir: string, context: Context): Mark {
  const atBase = under(context.baseUnder, dir).length > 0;
  const atHead = under(context.headUnder, dir).length > 0;

  if (atBase && atHead) return " ";

  return atHead ? "+" : "-";
}

function byName(a: Node, b: Node): number {
  return a.name.localeCompare(b.name);
}

function countIfOnlyModified(node: Node, context: Context): number | null {
  const known = context.modifiedCounts.get(node);

  if (known !== undefined) return known;

  let count: number | null = 0;

  for (const child of node.children.values()) {
    if (child.leaf !== null) {
      if (child.leaf.mark !== " ") {
        count = null;
        break;
      }

      count += 1;
    }

    if (child.children.size > 0) {
      const below = countIfOnlyModified(child, context);

      if (below === null) {
        count = null;
        break;
      }

      count += below;
    }
  }

  context.modifiedCounts.set(node, count);

  return count;
}

// A path can be a file on one side and a directory on the other: such a node
// carries both a leaf and children, and is listed once as each.
function toEntries(node: Node, context: Context): Entry[] {
  const children = [...node.children.values()];
  const dirs = children.filter((child) => child.children.size > 0).toSorted(byName);
  const files = children.filter((child) => child.leaf !== null).toSorted(byName);
  const modified = files.filter((file) => file.leaf?.mark === " ").length;
  const collapse = modified > MAX_LISTED_MODIFIED;
  const entries = dirs.map((dir) => toDirEntry(dir, context));

  for (const file of files) {
    if (file.leaf === null || (collapse && file.leaf.mark === " ")) continue;
    entries.push({ kind: "line", name: file.name, line: file.leaf });
  }

  if (collapse) {
    const where = node.path === "" ? " at the root" : "";
    entries.push({
      kind: "line",
      name: `(${modified} files modified${where})`,
      line: { mark: " ", note: "" },
    });
  }

  return entries;
}

function toDirEntry(node: Node, context: Context): Entry {
  const folded = fold(node.path, context);

  if (folded !== null) return { kind: "line", line: folded, name: `${node.name}/` };

  const modified = countIfOnlyModified(node, context);

  if (modified !== null && modified > MAX_LISTED_MODIFIED) {
    return {
      kind: "line",
      name: `${node.name}/`,
      line: { mark: " ", note: `(${modified} files modified)` },
    };
  }

  const mark = dirMark(node.path, context);
  const children = toEntries(node, context);
  const [only] = children;

  // A chain of single directories reads as one path: `archive/constitution/`.
  if (children.length === 1 && only !== undefined) {
    if (only.kind === "dir" && only.mark === mark) {
      return { kind: "dir", mark, name: `${node.name}/${only.name}`, children: only.children };
    }

    if (only.kind === "line" && only.name.endsWith("/") && only.line.mark === mark) {
      return { kind: "line", name: `${node.name}/${only.name}`, line: only.line };
    }
  }

  return { kind: "dir", mark, name: node.name, children };
}

function render(entries: readonly Entry[], indent: string, top: boolean): string[] {
  const lines: string[] = [];

  entries.forEach((entry, position) => {
    const last = position === entries.length - 1;
    const branch = top ? "" : last ? "└── " : "├── ";
    const deeper = top ? "" : `${indent}${last ? "    " : "│   "}`;

    if (entry.kind === "line") {
      const note = entry.line.note === "" ? "" : `  ${entry.line.note}`;
      lines.push(`${entry.line.mark}${indent}${branch}${entry.name}${note}`);

      return;
    }

    lines.push(
      `${entry.mark}${indent}${branch}${entry.name}/`,
      ...render(entry.children, deeper, false),
    );
  });

  return lines;
}

/** The tree diff lines, each starting with its diff mark: " ", "+" or "-". */
export function treeDiff(snapshot: Snapshot): string[] {
  const root = newNode("", "");
  const byPath = new Map<string, Change>();

  for (const change of snapshot.changes) {
    byPath.set(change.path, change);
    insert(root, change.path, lineFor(change));
  }

  const context: Context = {
    byPath,
    baseUnder: indexByDir(snapshot.baseFiles),
    headUnder: indexByDir(snapshot.headFiles),
    modifiedCounts: new Map(),
  };

  return render(toEntries(root, context), "", true);
}

async function git(...args: string[]): Promise<string> {
  const { stdout, stderr, exitCode } = await $`git ${args}`.quiet().nothrow();

  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.toString().trim()}`);

  return stdout.toString();
}

// `--full-tree`: from a subdirectory, ls-tree would list that subtree with
// paths relative to it, while `git diff` always prints them from the root.
async function filesAt(ref: string): Promise<Set<string>> {
  const raw = await git("ls-tree", "--full-tree", "-r", "-z", "--name-only", ref);

  return new Set(raw.split("\0").filter((path) => path !== ""));
}

async function snapshotFor(base: string): Promise<Snapshot> {
  const mergeBase = (await git("merge-base", base, "HEAD")).trim();

  const [diff, baseFiles, headFiles] = await Promise.all([
    git("diff", "--name-status", "-M", "-C", "-z", `${mergeBase}..HEAD`),
    filesAt(mergeBase),
    filesAt("HEAD"),
  ]);

  return { changes: parseNameStatus(diff), baseFiles, headFiles };
}

async function main(argv: readonly string[]): Promise<number> {
  const [base, ...extra] = argv;

  if (base === undefined || base === "-h" || base === "--help" || extra.length > 0) {
    console.error(USAGE);

    return 2;
  }

  const lines = treeDiff(await snapshotFor(base));

  if (lines.length === 0) {
    console.error(`no change between ${base} and HEAD`);

    return 1;
  }

  console.log(lines.join("\n"));

  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main(Bun.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
