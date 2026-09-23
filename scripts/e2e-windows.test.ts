import { expect, test } from "bun:test";
import { join } from "node:path";

import { $ } from "bun";
import { parse } from "yaml";

const ROOT = join(import.meta.dir, "..");

// Run inside `vellum/`, not imported: no relative import leaves its top-level directory.
const PRINT_WINDOWS = `const { default: config } = await import("./e2e/playwright.config.ts");
console.log(JSON.stringify(config.projects?.map((project) => project.name)));`;

interface Workflow {
  readonly jobs?: Readonly<
    Record<string, { readonly strategy?: { readonly matrix?: { readonly window?: unknown } } }>
  >;
}

test("CI runs one e2e job per window of the Playwright config", async () => {
  const windows: unknown = await $`${process.execPath} -e ${PRINT_WINDOWS}`
    .cwd(join(ROOT, "vellum"))
    .json();

  const workflow: Workflow = parse(await Bun.file(join(ROOT, ".github/workflows/ci.yml")).text());

  expect(windows).toBeArray();
  expect(workflow.jobs?.["e2e-window"]?.strategy?.matrix?.window).toEqual(windows);
});
