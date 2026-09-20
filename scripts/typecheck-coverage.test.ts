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

  const checked = new Set((await $`bun x tsgo --noEmit --listFiles`.cwd(ROOT).text()).split("\n"));

  expect(tracked.filter((path) => !checked.has(join(ROOT, path)))).toEqual([]);
});
