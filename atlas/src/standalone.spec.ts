import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { bunFlags } from "./server/wire.ts";

// The plugin is installed as a copy of its own folder, with no repository around it: what the
// page needs to build, and the WebAssembly it loads, is found from inside the folder.
const ROOT = dirname(import.meta.dir);

const running: Bun.Subprocess[] = [];

const copies: string[] = [];

afterEach(async () => {
  for (const server of running.splice(0)) {
    server.kill("SIGKILL");
    await server.exited;
  }

  for (const copy of copies.splice(0)) rmSync(copy, { recursive: true, force: true });
});

/** The plugin's folder under the temp directory, its installed packages linked as they are. */
function pluginCopy(): string {
  const copy = mkdtempSync(join(tmpdir(), "atlas-alone-"));
  copies.push(copy);

  cpSync(ROOT, copy, { recursive: true, filter: (from) => from !== join(ROOT, "node_modules") });
  // A junction on Windows, which creates one with no privilege; a symbolic link elsewhere.
  symlinkSync(join(ROOT, "node_modules"), join(copy, "node_modules"), "junction");

  return copy;
}

test("a copy of the folder outside any repository serves the sample's page and libavoid.wasm", async () => {
  const plugin = pluginCopy();
  const sample = join(plugin, "fixtures", "sample");

  const server = Bun.spawn(
    [process.execPath, ...bunFlags(plugin), join(plugin, "src", "serve.ts"), sample, "0"],
    { cwd: plugin, stdout: "pipe", stderr: "ignore" },
  );

  running.push(server);
  const { value } = await server.stdout.getReader().read();
  const address = new TextDecoder().decode(value).split("\n")[0] ?? "";
  const page = await fetch(address);
  const wasm = await fetch(new URL("/libavoid.wasm", address));

  expect(page.status).toBe(200);
  expect(await page.text()).toContain("atlas-token");
  expect(wasm.status).toBe(200);
  expect(wasm.headers.get("content-type")).toBe("application/wasm");
}, 15_000);
