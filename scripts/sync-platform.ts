#!/usr/bin/env bun

/**
 * Hold every copy of `tools/platform/` to its source: the gate `platform-copies`.
 *
 *   bun ./scripts/sync-platform.ts          checks, writes nothing
 *   bun ./scripts/sync-platform.ts --write  writes the copies `consumers.ts` lists, then checks
 *
 * A plugin stands alone once installed, so it imports its own copy, never the source, and nothing
 * outside its directory. A copy holds the modules its owner's files import from it, an import
 * marked `type` included, and the modules those import in turn. The check refuses a copy that
 * differs from its source byte for byte, a module a copy lacks or holds though nothing imports it,
 * an import of a file that is no module of the source, a consumer whose directory does not exist
 * or whose copy nothing imports, a copy directory `consumers.ts` does not list, and an import that
 * leaves a plugin's or a consumer's directory. A copy holds what git lists there: an ignored file
 * is neither refused nor removed.
 */

import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

import { CONSUMERS } from "../tools/platform/consumers.ts";
import { writeAtomic } from "../tools/platform/fs.ts";
import { gitRead } from "../tools/platform/git.ts";
import { isInsideRelative, isUnder } from "../tools/platform/pure.ts";

export const SOURCE_DIR = "tools/platform";

export const WRITE_COMMAND = "bun ./scripts/sync-platform.ts --write";

const NEVER_A_COPY = `edit ${SOURCE_DIR}/, never a copy, then run ${WRITE_COMMAND}`;

/** Where a copy may live: `<owner>/lib/platform` or `<owner>/src/platform`, its owner at the root. */
const COPY_DIR = /^[^/]+\/(?:lib|src)\/platform$/u;

/** A file inside a copy directory, at any depth, as git lists it. */
const IN_COPY_DIR = /^(.*?(?:^|\/)(?:lib|src)\/platform)\//u;

const LOADERS = new Map<string, "ts" | "tsx" | "js" | "jsx">([
  [".ts", "ts"],
  [".tsx", "tsx"],
  [".mts", "ts"],
  [".cts", "ts"],
  [".js", "js"],
  [".mjs", "js"],
  [".cjs", "js"],
  [".jsx", "jsx"],
]);

type Catalog = { readonly plugins: readonly { readonly source: string }[] };

/** A catalog source `./`, normalised: the repository itself is the plugin, every file under it. */
const REPOSITORY = ".";

/** How deep a standalone directory lies, for the deepest to come first: `.` the shallowest. */
const depthOf = (dir: string): number => (dir === REPOSITORY ? 0 : dir.length);

const ownerOf = (path: string): string => path.slice(0, Math.max(0, path.indexOf("/")));

/** The files git sees under `root`, tracked or new and not ignored, that are on disk. */
async function listedFiles(root: string): Promise<string[]> {
  const args = ["ls-files", "--cached", "--others", "--exclude-standard", "-z"];

  return (await gitRead(args, { cwd: root, raw: true }))
    .split("\0")
    .filter((path) => path !== "" && !path.startsWith("archive/") && existsSync(join(root, path)));
}

function heldBy(dir: string, files: readonly string[]): string[] {
  const prefix = `${dir}/`;

  return files.flatMap((file) => (file.startsWith(prefix) ? [file.slice(prefix.length)] : []));
}

function manifestProblems(root: string, dirs: readonly string[]): string[] {
  const seen = new Set<string>();

  return dirs.flatMap((dir) => {
    const problems: string[] = [];

    if (!COPY_DIR.test(dir)) {
      problems.push(
        `${dir}: a copy lives at <owner>/lib/platform or <owner>/src/platform, its owner a directory at the root; fix tools/platform/consumers.ts`,
      );
    } else if (!existsSync(join(root, ownerOf(dir)))) {
      problems.push(
        `${dir}: tools/platform/consumers.ts lists it, but ${ownerOf(dir)}/ does not exist; fix the entry`,
      );
    }

    if (seen.has(dir)) problems.push(`${dir}: tools/platform/consumers.ts lists it twice`);
    seen.add(dir);

    return problems;
  });
}

/** The copies that can be checked or written: a valid directory whose owner exists. */
function placed(root: string, dirs: readonly string[]): readonly string[] {
  return dirs.filter((dir) => COPY_DIR.test(dir) && existsSync(join(root, ownerOf(dir))));
}

/**
 * Each specifier a file names after `from`, `import` or `require`, an import marked `type`
 * included, which the transpiler drops: a copy holds what the typecheck reads as well.
 */
const SPECIFIER = /\b(?:from|import|require)\s*\(?\s*["']([^"']+)["']/gu;

/** A line of a comment, whose path imports nothing: it opens with `//`, `/*` or `*`. */
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*)/u;

/** The files below `dir` that `file`'s relative imports name, `/` between their folders. */
function importedFrom(
  file: string,
  dir: string,
): { readonly specifier: string; readonly name: string }[] {
  const code = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !COMMENT_LINE.test(line))
    .join("\n");

  return [...code.matchAll(SPECIFIER)].flatMap(([, specifier]) => {
    if (specifier?.startsWith(".") !== true) return [];
    const name = relative(dir, resolve(dirname(file), specifier));

    return name !== "" && isInsideRelative(name, [sep])
      ? [{ specifier, name: name.split(sep).join("/") }]
      : [];
  });
}

/** Whether a file at the top of the source, by its name, is a module a copy can hold. */
export const isModuleName = (name: string): boolean =>
  name.endsWith(".ts") && !name.includes(".test.") && name !== "consumers.ts";

/** The modules a copy can hold: each file at the top of the source that git tracks, by its name. */
async function sourceModules(root: string): Promise<ReadonlySet<string>> {
  const prefix = `${SOURCE_DIR}/`;
  const args = ["ls-files", "--cached", "-z", "--", SOURCE_DIR];

  return new Set(
    (await gitRead(args, { cwd: root, raw: true })).split("\0").flatMap((path) => {
      const name = path.slice(prefix.length);

      return path.startsWith(prefix) &&
        !name.includes("/") &&
        isModuleName(name) &&
        existsSync(join(root, path))
        ? [name]
        : [];
    }),
  );
}

/** `names` and every module they import, at any depth, as the source's modules import one another. */
function withTheirImports(
  root: string,
  source: ReadonlySet<string>,
  names: ReadonlySet<string>,
): string[] {
  const held = new Set<string>();
  const waiting = [...names];

  for (let name = waiting.pop(); name !== undefined; name = waiting.pop()) {
    if (held.has(name)) continue;
    held.add(name);

    for (const imported of importedFrom(join(root, SOURCE_DIR, name), join(root, SOURCE_DIR))) {
      if (source.has(imported.name)) waiting.push(imported.name);
    }
  }

  return [...held].toSorted();
}

/**
 * What a copy must hold: the modules its owner's files, outside the copy, import from it, with
 * what those import; and each import of a file the source does not hold, refused.
 */
type CopyPlan = { readonly modules: readonly string[]; readonly strays: readonly string[] };

function planOf(
  root: string,
  source: ReadonlySet<string>,
  dir: string,
  files: readonly string[],
): CopyPlan {
  const owner = ownerOf(dir);
  const imported = new Set<string>();
  const strays: string[] = [];

  for (const file of files) {
    if (!isUnder(owner, file, "/") || isUnder(dir, file, "/") || !LOADERS.has(extname(file)))
      continue;

    for (const { specifier, name } of importedFrom(join(root, file), join(root, dir))) {
      if (source.has(name)) imported.add(name);
      else
        strays.push(
          `${file} imports ${specifier}, no module of ${SOURCE_DIR}/: a copy holds a .ts file git tracks there, neither a test nor consumers.ts`,
        );
    }
  }

  return { modules: withTheirImports(root, source, imported), strays };
}

/** Whether `copy` is a file holding exactly `source`'s bytes: a link to it is not, once installed. */
function isExactCopy(copy: string, source: string): boolean {
  return !lstatSync(copy).isSymbolicLink() && readFileSync(copy).equals(readFileSync(source));
}

function copyProblems(
  root: string,
  source: ReadonlySet<string>,
  dir: string,
  files: readonly string[],
): string[] {
  const owner = ownerOf(dir);
  const { modules, strays } = planOf(root, source, dir, files);

  if (modules.length === 0 && strays.length === 0) {
    return [
      `${dir}: nothing in ${owner}/ imports a module of it: remove the directory and its entry in tools/platform/consumers.ts`,
    ];
  }

  const held = heldBy(dir, files);

  const missingOrDiffering = modules.flatMap((file) => {
    const copy = join(root, dir, file);
    const where = `${dir}/${file}`;

    if (!existsSync(copy)) return [`${where} is missing: run ${WRITE_COMMAND}`];

    if (lstatSync(copy).isSymbolicLink())
      return [`${where} is a symbolic link, which a plugin installed alone loses: ${NEVER_A_COPY}`];

    if (!held.includes(file))
      return [`${where} is ignored by git, so no commit carries it: unignore it`];

    return readFileSync(copy).equals(readFileSync(join(root, SOURCE_DIR, file)))
      ? []
      : [`${where} differs from ${SOURCE_DIR}/${file}: ${NEVER_A_COPY}`];
  });

  const unimported = removable(held, { modules, strays }).map(
    (file) =>
      `${dir}/${file} is no module ${owner}/ imports, directly or through another: run ${WRITE_COMMAND}, which removes it`,
  );

  return [...missingOrDiffering, ...unimported, ...strays];
}

/**
 * What `--write` removes of the files git lists in a copy: those beyond its modules, and none
 * while an import names no module, a typo maybe for one the copy holds.
 */
function removable(held: readonly string[], plan: CopyPlan): readonly string[] {
  return plan.strays.length > 0 ? [] : held.filter((file) => !plan.modules.includes(file));
}

function unlistedCopyDirs(files: readonly string[], dirs: readonly string[]): string[] {
  const listed = new Set(dirs);

  const unlisted = new Set(
    files.flatMap((file) => {
      const dir = IN_COPY_DIR.exec(file)?.[1];

      return dir === undefined || listed.has(dir) ? [] : [dir];
    }),
  );

  return [...unlisted]
    .toSorted()
    .map(
      (dir) =>
        `${dir}/ holds files tools/platform/consumers.ts lists no copy for: add its entry and run ${WRITE_COMMAND}, or move them out`,
    );
}

/**
 * The plugins of the catalog, at any depth, and the consumers' owners: the directories that stand
 * alone, the deepest first, so the first one a file lies under is the one it belongs to.
 */
function standaloneDirs(root: string, copyDirs: readonly string[]): readonly string[] {
  // SAFETY: validate-marketplace holds marketplace.json to this form.
  const catalog = JSON.parse(
    readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8"),
  ) as Catalog;

  const dirs = new Set([
    ...catalog.plugins.map((plugin) => posix.normalize(plugin.source).replace(/\/$/u, "")),
    ...copyDirs.map((dir) => ownerOf(dir)),
  ]);

  return [...dirs].toSorted((a, b) => depthOf(b) - depthOf(a));
}

/** What the file loads at run time: the transpiler drops every type-only import, and reads no shebang. */
function valueImports(file: string): string[] {
  const loader = LOADERS.get(extname(file));

  if (loader === undefined) return [];

  return new Bun.Transpiler({ loader })
    .scanImports(readFileSync(file, "utf8").replace(/^#!.*\n/u, ""))
    .map(({ path }) => path);
}

function outsideImport(file: string, owner: string, specifier: string, target: string): string {
  return isInsideRelative(posix.relative(SOURCE_DIR, target), ["/"])
    ? `${file} imports ${specifier}: a plugin imports the copy in its own directory, listed in tools/platform/consumers.ts and written by ${WRITE_COMMAND}; ${NEVER_A_COPY}`
    : `${file} imports ${specifier}, outside ${owner}/: a plugin stands alone once installed, so no import leaves its directory`;
}

/** Each value import of a standalone directory's file that resolves outside that directory. */
function outsideImports(
  root: string,
  files: readonly string[],
  copyDirs: readonly string[],
): string[] {
  const owners = standaloneDirs(root, copyDirs);

  return files.flatMap((file) => {
    const owner = owners.find((dir) => dir === REPOSITORY || isUnder(dir, file, "/"));

    if (owner === undefined) return [];

    return valueImports(join(root, file))
      .filter((specifier) => specifier.startsWith(".") || isAbsolute(specifier))
      .flatMap((specifier) => {
        const resolved = resolve(dirname(join(root, file)), specifier);

        if (isInsideRelative(relative(join(root, owner), resolved), [sep])) return [];
        const target = relative(root, resolved).split(sep).join("/");

        return [outsideImport(file, owner, specifier, target)];
      });
  });
}

/** Every refusal of the gate, in the order a fix takes them: the manifest, the copies, the strays, the imports. */
export async function problemsIn(root: string, copyDirs: readonly string[]): Promise<string[]> {
  const files = await listedFiles(root);
  const source = await sourceModules(root);

  return [
    ...manifestProblems(root, copyDirs),
    ...placed(root, copyDirs).flatMap((dir) => copyProblems(root, source, dir, files)),
    ...unlistedCopyDirs(files, copyDirs),
    ...outsideImports(root, files, copyDirs),
  ];
}

/**
 * Writes each module a copy must hold that differs or is missing, and removes what git lists there
 * beyond them, unless an import names no module.
 */
export async function writeCopies(root: string, copyDirs: readonly string[]): Promise<string[]> {
  const files = await listedFiles(root);
  const source = await sourceModules(root);
  const written: string[] = [];

  for (const dir of placed(root, copyDirs)) {
    const plan = planOf(root, source, dir, files);

    for (const file of plan.modules) {
      const from = join(root, SOURCE_DIR, file);
      const copy = join(root, dir, file);

      if (existsSync(copy) && isExactCopy(copy, from)) continue;
      await writeAtomic(copy, readFileSync(from), { mkdir: true });
      written.push(`${dir}/${file}`);
    }

    for (const file of removable(heldBy(dir, files), plan)) {
      rmSync(join(root, dir, file));
      written.push(`${dir}/${file} (removed)`);
    }
  }

  return written;
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");

  if (process.argv.includes("--write")) {
    for (const line of await writeCopies(root, CONSUMERS)) console.log(`wrote ${line}`);
  }

  const problems = await problemsIn(root, CONSUMERS);

  if (problems.length > 0) {
    console.error(`${problems.length} platform copy problem(s):\n`);

    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
}
