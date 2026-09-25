import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The plugin is installed as a copy of its own folder, with no repository around it: what it
 * needs to build its page is inside the folder, or the installed page answers 500.
 */

const ROOT = join(import.meta.dir, "..");

const running: Bun.Subprocess[] = [];

afterEach(() => {
  for (const preview of running.splice(0)) preview.kill("SIGKILL");
});

/** The plugin's folder under the temp directory, where no parent holds a `tsconfig.json`. */
function pluginCopy(): string {
  const copy = mkdtempSync(join(tmpdir(), "vellum-alone-"));

  cpSync(ROOT, copy, {
    recursive: true,
    filter: (from) => from !== join(ROOT, "node_modules"),
  });
  // A junction on Windows, which creates one with no privilege; a symbolic link elsewhere.
  symlinkSync(join(ROOT, "node_modules"), join(copy, "node_modules"), "junction");

  return copy;
}

async function pageServedFrom(plugin: string): Promise<Response> {
  const project = mkdtempSync(join(tmpdir(), "vellum-alone-project-"));
  const source = join(project, "source");

  mkdirSync(source);
  writeFileSync(join(source, "plan.md"), "# Plan\n");

  const preview = Bun.spawn(["bun", join(plugin, "src/core/server/preview.ts"), source], {
    cwd: project,
    stderr: "ignore",
  });

  running.push(preview);

  const { value } = await preview.stdout.getReader().read();

  return fetch(new TextDecoder().decode(value).trim());
}

describe("the plugin alone", () => {
  test("a copy of the folder outside any repository builds and serves its page", async () => {
    const page = await pageServedFrom(pluginCopy());

    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="root">');
  });
});
