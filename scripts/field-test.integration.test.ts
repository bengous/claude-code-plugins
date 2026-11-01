import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/** A PATH of bun and a git that fails, a `sleep` holding its pipes past the platform's grace. */
function failingHeldGit(): string {
  const bin = join(root, "bin");

  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "bun"));
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\necho 'fatal: refused' >&2\n'${Bun.which("sleep")}' 3 &\nexit 128\n`,
    { mode: 0o755 },
  );

  return bin;
}

const LOST = "exited 128, its output let go of after 1000 ms";

test("a worktree add that fails with its output let go of says so, not an empty reason", () => {
  const temp = join(root, "tmp");

  mkdirSync(temp);

  const started = Bun.spawnSync(
    [process.execPath, SCRIPT, "start", "probe", "atlas", "--ref", "dev"],
    {
      env: { ...process.env, PATH: failingHeldGit(), TMPDIR: temp },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  expect(started.stderr.toString()).toStartWith("git worktree add dev: git -C ");
  expect(started.stderr.toString()).toContain(LOST);
  expect(started.exitCode).toBe(1);
});

test("a stop whose worktree remove fails with its output let go of says so, not an empty reason", () => {
  const temp = join(root, "tmp");
  const source = join(temp, "field-test-probe", "source");

  mkdirSync(source, { recursive: true });

  const stopped = Bun.spawnSync([process.execPath, SCRIPT, "stop", "probe"], {
    env: { ...process.env, PATH: failingHeldGit(), TMPDIR: temp },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(stopped.stderr.toString()).toStartWith(
    `not removed:\ngit worktree remove ${source}: git -C `,
  );
  expect(stopped.stderr.toString()).toContain(LOST);
  expect(stopped.exitCode).toBe(1);
});
