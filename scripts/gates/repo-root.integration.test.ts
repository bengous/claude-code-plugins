import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPTS = ["sync-versions.ts", "validate-frontmatter.ts", "validate-marketplace.ts"];

let root = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "repo-root-"));
  mkdirSync(join(root, "bin"));
  // A git that fails as outside a repository, its pipes held past the platform's grace by a `sleep`.
  writeFileSync(
    join(root, "bin", "git"),
    "#!/bin/sh\necho 'fatal: not a git repository' >&2\nsleep 3 &\nexit 128\n",
    { mode: 0o755 },
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

test.each(SCRIPTS)(
  "%s throws the repo root's output let go of, rather than read its exit as no repository",
  (script) => {
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, script)], {
      cwd: root,
      env: { ...process.env, PATH: `${join(root, "bin")}:${process.env["PATH"] ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderr = result.stderr.toString();

    expect(stderr).not.toContain("Not in a git repository");
    expect(stderr).toContain(
      "git rev-parse --show-toplevel exited 128, its output let go of after 1000 ms",
    );
    expect(result.exitCode).toBe(1);
  },
);
