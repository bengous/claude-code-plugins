import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gitRead } from "../../../lib/platform/git.ts";
import { listFiles } from "./files.ts";

const ISOLATED = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tree(): string {
  const dir = mkdtempSync(join(tmpdir(), "architecture-map-files-"));

  dirs.push(dir);
  mkdirSync(join(dir, "build"));
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "build", "steps.py"), "x = 1\n");
  writeFileSync(join(dir, "node_modules", "dep.py"), "y = 1\n");
  writeFileSync(join(dir, "main.py"), "import build.steps\n");

  return dir;
}

test("a folder git tracks is listed, whatever its name", async () => {
  const dir = tree();

  await gitRead(["init", "-q"], { cwd: dir, env: ISOLATED });
  await gitRead(["add", "build", "main.py"], { cwd: dir, env: ISOLATED });

  expect(await listFiles(dir, true, (path) => path.endsWith(".py"), [])).toEqual([
    "build/steps.py",
    "main.py",
  ]);
});

test("walking the folder skips dependency and build folders", async () => {
  const dir = tree();

  expect(await listFiles(dir, false, (path) => path.endsWith(".py"), [])).toEqual(["main.py"]);
});
