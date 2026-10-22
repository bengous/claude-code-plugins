import { expect, test } from "bun:test";
import { join } from "node:path";

import { $ } from "bun";

const ROOT = join(import.meta.dir, "..");

/** What `tsconfig.json` leaves out on purpose; anything else tracked must be type-checked. */
const LEFT_OUT = /^(?:archive|tools\/oxlint\/anti-slop)\//u;

/**
 * `tsgo --showConfig`: the files `include` and `exclude` select, read from directory listings.
 * Not `--listFilesOnly`: it reads every source and type the program loads, which a loaded
 * runner cannot always do within bun's per-test limit.
 */
type ShownConfig = { readonly files: readonly string[] };

test("every tracked TypeScript file is in the typecheck, dot directories included", async () => {
  const tracked = (await $`git ls-files '*.ts' '*.tsx'`.cwd(ROOT).text())
    .split("\n")
    .filter((path) => path !== "" && !LEFT_OUT.test(path));

  // SAFETY: tsgo prints the resolved tsconfig.json as JSON, `files` listing paths relative to it.
  const { files } = (await $`bun x tsgo --showConfig`.cwd(ROOT).json()) as ShownConfig;
  const covered = new Set(files.map((path) => join(ROOT, path)));

  expect(tracked.filter((path) => !covered.has(join(ROOT, path)))).toEqual([]);
});

type TsConfig = {
  readonly compilerOptions?: Readonly<Record<string, boolean | string | string[]>>;
};

async function tsconfig(path: string): Promise<TsConfig> {
  // SAFETY: a `tsconfig.json` of this repository, read for the one field the test compares.
  return (await Bun.file(join(ROOT, path)).json()) as TsConfig;
}

/** A plugin's own `tsconfig.json` sits at its folder's root, one level under the repository's. */
const PLUGIN_TSCONFIG = /^(?!archive\/)[^/]+\/tsconfig\.json$/u;

test("every plugin's own tsconfig.json compiles as the root's does", async () => {
  const root = await tsconfig("tsconfig.json");

  const plugins = (await $`git ls-files '*/tsconfig.json'`.cwd(ROOT).text())
    .split("\n")
    .filter((path) => PLUGIN_TSCONFIG.test(path));

  expect(root.compilerOptions).toBeDefined();
  expect(plugins).toContain("vellum/tsconfig.json");

  for (const path of plugins) {
    expect({ path, options: (await tsconfig(path)).compilerOptions }).toEqual({
      path,
      options: root.compilerOptions,
    });
  }
});
