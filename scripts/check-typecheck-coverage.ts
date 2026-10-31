#!/usr/bin/env bun

/**
 * Refuse a tracked TypeScript file the typecheck does not cover.
 *
 * `tsconfig.json`'s `**` skips dot directories, so a file under `.claude/` or
 * `.lefthook/` is left out unless `include` names it. `tsgo --showConfig`
 * prints the files `include` and `exclude` select, read from directory
 * listings alone; `--listFilesOnly` would load every source and type.
 */

import { join } from "node:path";

import { $ } from "bun";

import { GitError, git } from "../tools/platform/node.ts";

/** What `tsconfig.json` leaves out on purpose; anything else tracked must be type-checked. */
const LEFT_OUT = /^(?:archive|tools\/oxlint\/anti-slop)\//u;

/** `tsgo --showConfig`'s answer, `files` relative to the config's directory. */
type ShownConfig = { readonly files: readonly string[] };

/** The tracked paths, relative to `root`, that no file of the config's `files` is. */
export function uncovered(
  root: string,
  tracked: readonly string[],
  covered: readonly string[],
): string[] {
  const typechecked = new Set(covered.map((path) => join(root, path)));

  return tracked.filter(
    (path) => path !== "" && !LEFT_OUT.test(path) && !typechecked.has(join(root, path)),
  );
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const listing = ["ls-files", "*.ts", "*.tsx"];
  const listed = await git(listing, { cwd: root });

  if (listed.kind !== "exited" || listed.code !== 0) throw new GitError(listing, listed);
  const tracked = listed.stdout.split("\n");

  // SAFETY: tsgo prints the resolved tsconfig.json as JSON, `files` listing paths relative to it.
  const { files } = (await $`bun x tsgo --showConfig`.cwd(root).json()) as ShownConfig;
  const missing = uncovered(root, tracked, files);

  if (missing.length > 0) {
    console.error(`${missing.length} tracked TypeScript file(s) outside the typecheck:\n`);

    for (const path of missing) console.error(`  ${path}`);

    console.error("\nName their directory in tsconfig.json's `include`.");
    process.exit(1);
  }
}
