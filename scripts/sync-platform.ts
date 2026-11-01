#!/usr/bin/env bun

/**
 * Hold every copy of `tools/platform/` to its source: the gate `platform-copies`.
 *
 *   bun ./scripts/sync-platform.ts          checks, writes nothing
 *   bun ./scripts/sync-platform.ts --write  writes the copies `consumers.ts` lists, then checks
 *
 * A plugin stands alone once installed, so it imports its own copy, never the source, and nothing
 * outside its directory. The check refuses a copy that differs from its source byte for byte, a
 * file a copy lacks or holds beyond its list, a consumer whose directory does not exist, a copy
 * directory `consumers.ts` does not list, and an import that leaves a plugin's or a consumer's
 * directory. A copy holds what git lists there: an ignored file is neither refused nor removed.
 */

import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

import type { Consumer } from "../tools/platform/consumers.ts";
import { CONSUMERS } from "../tools/platform/consumers.ts";
import { gitRead, writeAtomic } from "../tools/platform/node.ts";
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

function heldBy(consumer: Consumer, files: readonly string[]): string[] {
  const prefix = `${consumer.dir}/`;

  return files.flatMap((file) => (file.startsWith(prefix) ? [file.slice(prefix.length)] : []));
}

function manifestProblems(root: string, consumers: readonly Consumer[]): string[] {
  const seen = new Set<string>();

  return consumers.flatMap((consumer) => {
    const problems: string[] = [];

    if (!COPY_DIR.test(consumer.dir)) {
      problems.push(
        `${consumer.dir}: a copy lives at <owner>/lib/platform or <owner>/src/platform, its owner a directory at the root; fix tools/platform/consumers.ts`,
      );
    } else if (!existsSync(join(root, ownerOf(consumer.dir)))) {
      problems.push(
        `${consumer.dir}: tools/platform/consumers.ts lists it, but ${ownerOf(consumer.dir)}/ does not exist; fix the entry`,
      );
    }

    if (seen.has(consumer.dir))
      problems.push(`${consumer.dir}: tools/platform/consumers.ts lists it twice`);
    seen.add(consumer.dir);

    if (
      !consumer.files.includes("pure.ts") ||
      new Set(consumer.files).size !== consumer.files.length
    )
      problems.push(
        `${consumer.dir}: tools/platform/consumers.ts names its files once each, pure.ts alone or pure.ts and node.ts, which imports ./pure.ts`,
      );

    return problems;
  });
}

/** The consumers the copies can be checked or written for: a valid directory whose owner exists. */
function placed(root: string, consumers: readonly Consumer[]): readonly Consumer[] {
  return consumers.filter(
    (consumer) => COPY_DIR.test(consumer.dir) && existsSync(join(root, ownerOf(consumer.dir))),
  );
}

/** Whether `copy` is a file holding exactly `source`'s bytes: a link to it is not, once installed. */
function isExactCopy(copy: string, source: string): boolean {
  return !lstatSync(copy).isSymbolicLink() && readFileSync(copy).equals(readFileSync(source));
}

function copyProblems(root: string, consumer: Consumer, files: readonly string[]): string[] {
  const dir = join(root, consumer.dir);
  const listed = new Set<string>(consumer.files);
  const held = heldBy(consumer, files);

  const missingOrDiffering = consumer.files.flatMap((file) => {
    const copy = join(dir, file);
    const where = `${consumer.dir}/${file}`;

    if (!existsSync(copy)) return [`${where} is missing: run ${WRITE_COMMAND}`];

    if (lstatSync(copy).isSymbolicLink())
      return [`${where} is a symbolic link, which a plugin installed alone loses: ${NEVER_A_COPY}`];

    if (!held.includes(file))
      return [`${where} is ignored by git, so no commit carries it: unignore it`];

    return readFileSync(copy).equals(readFileSync(join(root, SOURCE_DIR, file)))
      ? []
      : [`${where} differs from ${SOURCE_DIR}/${file}: ${NEVER_A_COPY}`];
  });

  const extra = held
    .filter((file) => !listed.has(file))
    .map(
      (file) =>
        `${consumer.dir}/${file} is no file consumers.ts lists for ${consumer.dir}: ${NEVER_A_COPY}, which removes it`,
    );

  return [...missingOrDiffering, ...extra];
}

function unlistedCopyDirs(files: readonly string[], consumers: readonly Consumer[]): string[] {
  const listed = new Set(consumers.map((consumer) => consumer.dir));

  const dirs = new Set(
    files.flatMap((file) => {
      const dir = IN_COPY_DIR.exec(file)?.[1];

      return dir === undefined || listed.has(dir) ? [] : [dir];
    }),
  );

  return [...dirs]
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
function standaloneDirs(root: string, consumers: readonly Consumer[]): readonly string[] {
  // SAFETY: validate-marketplace holds marketplace.json to this form.
  const catalog = JSON.parse(
    readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8"),
  ) as Catalog;

  const dirs = new Set([
    ...catalog.plugins.map((plugin) => posix.normalize(plugin.source).replace(/\/$/u, "")),
    ...consumers.map((consumer) => ownerOf(consumer.dir)),
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
  consumers: readonly Consumer[],
): string[] {
  const owners = standaloneDirs(root, consumers);

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
export async function problemsIn(root: string, consumers: readonly Consumer[]): Promise<string[]> {
  const files = await listedFiles(root);

  return [
    ...manifestProblems(root, consumers),
    ...placed(root, consumers).flatMap((consumer) => copyProblems(root, consumer, files)),
    ...unlistedCopyDirs(files, consumers),
    ...outsideImports(root, files, consumers),
  ];
}

/** Writes each listed copy that differs or is missing, and removes what git lists there beyond the list. */
export async function writeCopies(root: string, consumers: readonly Consumer[]): Promise<string[]> {
  const files = await listedFiles(root);
  const written: string[] = [];

  for (const consumer of placed(root, consumers)) {
    const dir = join(root, consumer.dir);

    for (const file of consumer.files) {
      const source = join(root, SOURCE_DIR, file);
      const copy = join(dir, file);

      if (existsSync(copy) && isExactCopy(copy, source)) continue;
      await writeAtomic(copy, readFileSync(source), { mkdir: true });
      written.push(`${consumer.dir}/${file}`);
    }

    const listed = new Set<string>(consumer.files);

    for (const file of heldBy(consumer, files)) {
      if (listed.has(file)) continue;
      rmSync(join(dir, file));
      written.push(`${consumer.dir}/${file} (removed)`);
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
