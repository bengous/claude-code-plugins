import { expect, test } from "bun:test";
import { join } from "node:path";

import { $ } from "bun";

const ROOT = join(import.meta.dir, "..");

/** What `tsconfig.json` leaves out on purpose; anything else tracked must be type-checked. */
const LEFT_OUT = /^(?:archive|tools\/oxlint\/anti-slop)\//u;

test("every tracked TypeScript file is in the typecheck, dot directories included", async () => {
  const tracked = (await $`git ls-files '*.ts' '*.tsx'`.cwd(ROOT).text())
    .split("\n")
    .filter((path) => path !== "" && !LEFT_OUT.test(path));

  const checked = new Set((await $`bun x tsgo --listFilesOnly`.cwd(ROOT).text()).split("\n"));

  expect(tracked.filter((path) => !checked.has(join(ROOT, path)))).toEqual([]);
});

type TsConfig = {
  readonly compilerOptions?: Readonly<Record<string, boolean | string | string[]>>;
};

async function tsconfig(path: string): Promise<TsConfig> {
  // SAFETY: a `tsconfig.json` of this repository, read for the one field the test compares.
  return (await Bun.file(join(ROOT, path)).json()) as TsConfig;
}

test("a plugin's own tsconfig.json compiles as the root's does", async () => {
  const root = await tsconfig("tsconfig.json");
  const vellum = await tsconfig("vellum/tsconfig.json");

  expect(root.compilerOptions).toBeDefined();
  expect(vellum.compilerOptions).toEqual(root.compilerOptions);
});
