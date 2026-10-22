import { posix } from "node:path";

// What a repository's code reads, matched by pattern for `cli.ts inventory`: the imports between
// its directories, and the environment variables. Approximate by design: nothing is compiled.

/** Code-point order: the same on every machine, which a locale's collation is not. */
export const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The directory of the top two levels a path sits in, "." for the root's own files. */
export function unitOf(dir: string): string {
  return dir === "." || dir === "" ? "." : dir.split("/").slice(0, 2).join("/");
}

export const fileUnit = (file: string): string => unitOf(posix.dirname(file));

export type Edge = { readonly from: string; readonly to: string; readonly count: number };

export type Imports = { readonly note: string; readonly edges: readonly Edge[] };

export type EnvVar = {
  readonly name: string;
  /** The files that name it, FILES_SHOWN at most; `count` counts them all. */
  readonly files: readonly string[];
  readonly count: number;
};

export type Env = { readonly note: string; readonly vars: readonly EnvVar[] };

export const FILES_SHOWN = 10;

export const IMPORTS_NOTE =
  'Approximate, by pattern: TS/JS from "…", import "…", import() and require, and Python import statements, counted between the directories of the top two levels (\'.\' is the root\'s own files). A relative path is resolved; a bare name counts when it names a package.json of the repository or a top-level Python package in it. Path aliases and imports built at run time are missed.';

export const ENV_NOTE =
  "By pattern: process.env, Bun.env, import.meta.env and Deno.env in TS/JS; os.environ and getenv in Python; os.Getenv and os.LookupEnv in Go; env::var and env! in Rust; environment and ${…} in compose files; ENV and ARG in Dockerfiles; the keys of .env.example and its kin. A .env file is never read, and shell scripts are not scanned.";

const JS = /\.(?:[cm]?[jt]sx?)$/u;

const PYTHON = /\.py$/u;

const ENV_SAMPLE =
  /^(?:\.env\.(?:example|sample|template|dist|defaults)|(?:example|sample)\.env)$/u;

/** Whether the inventory reads `path` for its imports or its environment. */
export const isScanned = (path: string): boolean =>
  JS.test(path) ||
  PYTHON.test(path) ||
  path.endsWith(".go") ||
  path.endsWith(".rs") ||
  ENV_SAMPLE.test(posix.basename(path));

// Each one linear: an import or an export from a module is read off its `from "…"` alone, which
// only such a statement holds, never by spanning the statement from its keyword.
const JS_SPECIFIERS = [
  /(?:^|[^\w$.])from\s*['"]([^'"\n]+)['"]/gu,
  /(?:^|[^\w$.])import\s*['"]([^'"\n]+)['"]/gu,
  /(?:^|[^\w$.])(?:import|require)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/gu,
];

const PY_FROM = /^[ \t]*from[ \t]+(\.*\w*(?:\.\w+)*)[ \t]+import\b/gmu;

const PY_IMPORT =
  /^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)/gmu;

const ENV_PATTERNS: readonly {
  readonly applies: (path: string) => boolean;
  readonly patterns: readonly RegExp[];
}[] = [
  {
    applies: (path) => JS.test(path),
    patterns: [
      /\b(?:process|Bun)\.env\.([A-Za-z_]\w*)/gu,
      /\b(?:process|Bun)\.env\[\s*['"]([A-Za-z_]\w*)['"]\s*\]/gu,
      /\bimport\.meta\.env\.([A-Za-z_]\w*)/gu,
      /\bDeno\.env\.get\(\s*['"]([A-Za-z_]\w*)['"]/gu,
    ],
  },
  {
    applies: (path) => PYTHON.test(path),
    patterns: [
      /\benviron(?:\.get\(\s*|\[\s*)['"]([A-Za-z_]\w*)['"]/gu,
      /\bgetenv\(\s*['"]([A-Za-z_]\w*)['"]/gu,
    ],
  },
  {
    applies: (path) => path.endsWith(".go"),
    patterns: [/\bos\.(?:Getenv|LookupEnv)\(\s*"([A-Za-z_]\w*)"/gu],
  },
  {
    applies: (path) => path.endsWith(".rs"),
    patterns: [
      /\benv::var(?:_os)?\(\s*"([A-Za-z_]\w*)"/gu,
      /\b(?:option_)?env!\(\s*"([A-Za-z_]\w*)"/gu,
    ],
  },
  {
    applies: (path) => ENV_SAMPLE.test(posix.basename(path)),
    patterns: [/^[ \t]*(?:export[ \t]+)?([A-Za-z_]\w*)[ \t]*=/gmu],
  },
];

const captured = (text: string, pattern: RegExp): string[] =>
  [...text.matchAll(pattern)].flatMap(([, value]) => value ?? []);

/** The environment variables `text`, the content of `path`, reads. */
export function envOf(path: string, text: string): string[] {
  return ENV_PATTERNS.flatMap(({ applies, patterns }) =>
    applies(path) ? patterns.flatMap((pattern) => captured(text, pattern)) : [],
  );
}

/** The files and directories of the repository, and what its bare import names stand for. */
export type Tree = {
  readonly files: ReadonlySet<string>;
  readonly dirs: ReadonlySet<string>;
  /** A package.json's `name` → its directory. */
  readonly packages: ReadonlyMap<string, string>;
  /** A top-level Python package or module → its directory or file. */
  readonly modules: ReadonlyMap<string, string>;
};

const JS_SUFFIXES = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function jsTarget(tree: Tree, path: string): string | null {
  if (path.startsWith("..")) return null;
  const stem = path.replace(/\.[cm]?jsx?$/u, "");

  const candidates = [
    path,
    ...JS_SUFFIXES.map((suffix) => `${path}${suffix}`),
    ...JS_SUFFIXES.map((suffix) => `${stem}${suffix}`),
    ...JS_SUFFIXES.map((suffix) => `${path}/index${suffix}`),
  ];

  const file = candidates.find((candidate) => tree.files.has(candidate));

  if (file !== undefined) return fileUnit(file);

  return path === "." || tree.dirs.has(path) ? unitOf(path) : null;
}

function packageOf(tree: Tree, specifier: string): string | null {
  const segments = specifier.split("/");

  // A package name is one segment, or two under a scope: the longer one wins.
  const name = [segments.slice(0, 2).join("/"), segments[0] ?? ""].find((candidate) =>
    tree.packages.has(candidate),
  );

  if (name === undefined) return null;
  const dir = tree.packages.get(name) ?? ".";
  const rest = specifier.slice(name.length + 1);

  return jsTarget(tree, rest === "" ? dir : posix.join(dir, rest)) ?? unitOf(dir);
}

function jsUnit(tree: Tree, from: string, specifier: string): string | null {
  if (specifier.startsWith("./") || specifier.startsWith("../") || specifier === ".") {
    return jsTarget(tree, posix.normalize(posix.join(posix.dirname(from), specifier)));
  }

  return packageOf(tree, specifier);
}

/** The unit of the deepest folder or `.py` file `segments` names below the folder `base`. */
function pythonTarget(tree: Tree, base: string, segments: readonly string[]): string {
  let at = base;

  for (const segment of segments) {
    const next = at === "." ? segment : `${at}/${segment}`;

    if (tree.files.has(`${next}.py`)) return fileUnit(`${next}.py`);

    if (!tree.dirs.has(next)) break;
    at = next;
  }

  return unitOf(at);
}

function pythonUnit(tree: Tree, from: string, module: string): string | null {
  const dots = /^\.*/u.exec(module)?.[0].length ?? 0;

  const segments = module
    .slice(dots)
    .split(".")
    .filter((segment) => segment !== "");

  if (dots > 0) {
    const up = Array.from({ length: dots - 1 }, () => "..").join("/");
    const base = posix.normalize(posix.join(posix.dirname(from), up === "" ? "." : up));

    return base.startsWith("..") ? null : pythonTarget(tree, base, segments);
  }

  const [top, ...rest] = segments;
  const root = top === undefined ? undefined : tree.modules.get(top);

  if (root === undefined) return null;

  return tree.files.has(root) ? fileUnit(root) : pythonTarget(tree, root, rest);
}

/** The units `text`, the content of `path`, imports from, one per import statement. */
export function importsOf(tree: Tree, path: string, text: string): string[] {
  if (JS.test(path)) {
    return JS_SPECIFIERS.flatMap((pattern) => captured(text, pattern)).flatMap(
      (specifier) => jsUnit(tree, path, specifier) ?? [],
    );
  }

  if (!PYTHON.test(path)) return [];

  const modules = [
    ...captured(text, PY_FROM),
    ...captured(text, PY_IMPORT).flatMap((list) =>
      list.split(",").map((item) => item.trim().split(/\s+/u)[0] ?? ""),
    ),
  ];

  return modules.flatMap((module) => pythonUnit(tree, path, module) ?? []);
}

const isPackage = (files: ReadonlySet<string>, folder: string): boolean =>
  files.has(folder === "." ? "__init__.py" : `${folder}/__init__.py`);

/** The top-level Python packages (a folder with `__init__.py` under none) and modules, by name. */
export function pythonModules(files: ReadonlySet<string>): ReadonlyMap<string, string> {
  const found = [...files].flatMap((file): [string, string][] => {
    if (!PYTHON.test(file)) return [];
    const dir = posix.dirname(file);

    if (posix.basename(file) === "__init__.py") {
      return dir !== "." && !isPackage(files, posix.dirname(dir))
        ? [[posix.basename(dir), dir]]
        : [];
    }

    return isPackage(files, dir) ? [] : [[posix.basename(file, ".py"), file]];
  });

  const shortestFirst = found.toSorted(
    ([, a], [, b]) => a.split("/").length - b.split("/").length || byText(a, b),
  );

  const modules = new Map<string, string>();

  for (const [name, path] of shortestFirst) {
    if (!modules.has(name)) modules.set(name, path);
  }

  return modules;
}

/** Every directory a file sits under, the root excluded. */
export function dirsOf(files: Iterable<string>): Set<string> {
  const dirs = new Set<string>();

  for (const file of files) {
    for (let dir = posix.dirname(file); dir !== "."; dir = posix.dirname(dir)) dirs.add(dir);
  }

  return dirs;
}

/** The import counts between distinct units, each pair once, sorted. */
export function edgesOf(pairs: readonly (readonly [string, string])[]): Edge[] {
  const counts = new Map<string, Edge>();

  for (const [from, to] of pairs) {
    if (from === to) continue;
    const key = `${from}\0${to}`;
    counts.set(key, { from, to, count: (counts.get(key)?.count ?? 0) + 1 });
  }

  return [...counts.values()].toSorted((a, b) => byText(a.from, b.from) || byText(a.to, b.to));
}

/** Each variable with the files that read it, sorted by name. */
export function varsOf(reads: readonly (readonly [string, string])[]): EnvVar[] {
  const byName = new Map<string, Set<string>>();

  for (const [name, file] of reads) byName.set(name, (byName.get(name) ?? new Set()).add(file));

  return [...byName.entries()]
    .toSorted(([a], [b]) => byText(a, b))
    .map(([name, files]) => {
      const all = [...files].toSorted();

      return { name, files: all.slice(0, FILES_SHOWN), count: all.length };
    });
}
