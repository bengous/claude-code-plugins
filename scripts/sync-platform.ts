#!/usr/bin/env bun

/**
 * Hold every copy of `tools/platform/` to its source: the gate `platform-copies`.
 *
 *   bun ./scripts/sync-platform.ts          checks, writes nothing
 *   bun ./scripts/sync-platform.ts --write  writes the copies `consumers.ts` lists, then checks
 *
 * A plugin stands alone once installed, so it imports its own copy, never the source. The check
 * refuses a copy that differs from its source byte for byte, a file a copy lacks or holds beyond
 * its list, a consumer whose directory does not exist, a copy directory `consumers.ts` does not
 * list, and an import of `tools/platform/` from a plugin or a consumer's directory.
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Consumer } from "../tools/platform/consumers.ts";
import { CONSUMERS } from "../tools/platform/consumers.ts";
import { git, GitError, writeAtomic } from "../tools/platform/node.ts";
import { isInsideRelative } from "../tools/platform/pure.ts";

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

const ownerOf = (dir: string): string => dir.slice(0, dir.indexOf("/"));

/** The files git sees under `root`, tracked or new and not ignored, that are on disk. */
async function listedFiles(root: string): Promise<string[]> {
  const args = ["ls-files", "--cached", "--others", "--exclude-standard", "-z"];
  const result = await git(args, { cwd: root });

  if (result.kind !== "exited" || result.code !== 0) throw new GitError(args, result);

  return result.stdout
    .split("\0")
    .filter((path) => path !== "" && !path.startsWith("archive/") && existsSync(join(root, path)));
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"));
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

    if (consumer.files.length === 0 || new Set(consumer.files).size !== consumer.files.length)
      problems.push(
        `${consumer.dir}: tools/platform/consumers.ts lists no file, or one twice: name pure.ts, node.ts, or both`,
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

function copyProblems(root: string, consumer: Consumer): string[] {
  const dir = join(root, consumer.dir);
  const listed = new Set<string>(consumer.files);
  const held = existsSync(dir) && statSync(dir).isDirectory() ? filesUnder(dir) : [];

  const missingOrDiffering = consumer.files.flatMap((file) => {
    const copy = join(dir, file);

    if (!existsSync(copy)) return [`${consumer.dir}/${file} is missing: run ${WRITE_COMMAND}`];

    return readFileSync(copy).equals(readFileSync(join(root, SOURCE_DIR, file)))
      ? []
      : [`${consumer.dir}/${file} differs from ${SOURCE_DIR}/${file}: ${NEVER_A_COPY}`];
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

/** The plugins of the catalog and the consumers' owners: the directories that stand alone. */
function standaloneDirs(root: string, consumers: readonly Consumer[]): ReadonlySet<string> {
  // SAFETY: validate-marketplace holds marketplace.json to this form.
  const catalog = JSON.parse(
    readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8"),
  ) as Catalog;

  return new Set([
    ...catalog.plugins.map((plugin) => plugin.source.replace(/^\.\//u, "").replace(/\/$/u, "")),
    ...consumers.map((consumer) => ownerOf(consumer.dir)),
  ]);
}

/** What the file loads at run time: the transpiler drops every type-only import, and reads no shebang. */
function valueImports(file: string): string[] {
  const loader = LOADERS.get(extname(file));

  if (loader === undefined) return [];

  return new Bun.Transpiler({ loader })
    .scanImports(readFileSync(file, "utf8").replace(/^#!.*\n/u, ""))
    .map(({ path }) => path);
}

function sourceImports(
  root: string,
  files: readonly string[],
  consumers: readonly Consumer[],
): string[] {
  const owners = standaloneDirs(root, consumers);
  const source = join(root, SOURCE_DIR);

  return files
    .filter((file) => owners.has(file.slice(0, file.indexOf("/"))))
    .flatMap((file) =>
      valueImports(join(root, file))
        .filter((specifier) => specifier.startsWith(".") || isAbsolute(specifier))
        .filter((specifier) => {
          const target = relative(source, resolve(dirname(join(root, file)), specifier));

          return isInsideRelative(target, [sep]);
        })
        .map(
          (specifier) =>
            `${file} imports ${specifier}: a plugin imports the copy in its own directory, listed in tools/platform/consumers.ts and written by ${WRITE_COMMAND}; ${NEVER_A_COPY}`,
        ),
    );
}

/** Every refusal of the gate, in the order a fix takes them: the manifest, the copies, the strays, the imports. */
export async function problemsIn(root: string, consumers: readonly Consumer[]): Promise<string[]> {
  const files = await listedFiles(root);

  return [
    ...manifestProblems(root, consumers),
    ...placed(root, consumers).flatMap((consumer) => copyProblems(root, consumer)),
    ...unlistedCopyDirs(files, consumers),
    ...sourceImports(root, files, consumers),
  ];
}

/** Writes each listed copy that differs or is missing, and removes what a copy holds beyond its list. */
export async function writeCopies(root: string, consumers: readonly Consumer[]): Promise<string[]> {
  const written: string[] = [];

  for (const consumer of placed(root, consumers)) {
    const dir = join(root, consumer.dir);

    for (const file of consumer.files) {
      const content = readFileSync(join(root, SOURCE_DIR, file));
      const copy = join(dir, file);

      if (existsSync(copy) && readFileSync(copy).equals(content)) continue;
      await writeAtomic(copy, content, { mkdir: true });
      written.push(`${consumer.dir}/${file}`);
    }

    const listed = new Set<string>(consumer.files);

    for (const file of existsSync(dir) ? filesUnder(dir) : []) {
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
