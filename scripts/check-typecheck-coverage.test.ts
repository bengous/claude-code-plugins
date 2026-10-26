import { expect, test } from "bun:test";
import { join } from "node:path";

import { $ } from "bun";

import { uncovered } from "./check-typecheck-coverage.ts";

const ROOT = join(import.meta.dir, "..");

test("a tracked file the config's files leave out is uncovered, a dot directory's included", () => {
  const tracked = ["scripts/a.ts", ".claude/hooks/b.ts", ".lefthook/c.ts", ""];

  expect(uncovered("/repo", tracked, ["scripts/a.ts", "./.claude/hooks/b.ts"])).toEqual([
    ".lefthook/c.ts",
  ]);
});

test("archive and the vendored anti-slop plugin are left out on purpose", () => {
  const tracked = ["archive/old/x.ts", "tools/oxlint/anti-slop/rule.ts", "tools/oxlint/local/y.ts"];

  expect(uncovered("/repo", tracked, [])).toEqual(["tools/oxlint/local/y.ts"]);
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
