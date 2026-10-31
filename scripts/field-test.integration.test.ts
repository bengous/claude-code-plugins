import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "field-test.ts");

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "field-test-stop-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("a stop whose git cannot start removes the rest, then names the worktree it left", () => {
  const bunOnly = join(root, "bin");
  const temp = join(root, "tmp");
  const source = join(temp, "field-test-probe", "source");

  mkdirSync(bunOnly);
  symlinkSync(process.execPath, join(bunOnly, "bun"));
  mkdirSync(source, { recursive: true });

  const stopped = Bun.spawnSync([process.execPath, SCRIPT, "stop", "probe"], {
    env: { ...process.env, PATH: bunOnly, TMPDIR: temp },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(stopped.stderr.toString()).toStartWith(`not removed:\ngit worktree remove ${source}: `);
  expect(stopped.exitCode).toBe(1);
  expect(existsSync(join(temp, "field-test-probe"))).toBe(false);
});
