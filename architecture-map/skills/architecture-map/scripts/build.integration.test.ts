import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = import.meta.dir;

const EXAMPLES = join(HERE, "..", "examples");

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "architecture-map-test-"));

  dirs.push(dir);

  return dir;
}

test("the demo builds into a page and a preview, and reports both views", () => {
  const dir = scratch();
  const out = join(dir, "nested", "map.html");
  const preview = join(dir, "preview.html");

  const run = Bun.spawnSync([
    "bun",
    join(HERE, "build.ts"),
    "--graph",
    join(EXAMPLES, "demo.graph.json"),
    "--config",
    join(EXAMPLES, "demo.config.json"),
    "--out",
    out,
    "--preview",
    preview,
  ]);

  const stdout = run.stdout.toString();

  expect(run.exitCode).toBe(0);
  expect(stdout).toContain("29 files, 67 links");
  expect(stdout).toContain('view "today": ok 54, warn 5, bad 8');
  expect(stdout).toContain('view "proposal": ok 58, warn 9, bad 0; 9 file(s) moved, 20 stay');
  expect(readFileSync(out, "utf8")).toStartWith("<title>Shop site plan</title>");
  expect(existsSync(preview)).toBe(true);
});

test("a config error is one line on stderr and exit 1", () => {
  const dir = scratch();

  const run = Bun.spawnSync([
    "bun",
    join(HERE, "build.ts"),
    "--graph",
    join(dir, "missing.json"),
    "--out",
    join(dir, "map.html"),
  ]);

  expect(run.exitCode).toBe(1);
  expect(run.stderr.toString()).toStartWith("build: cannot read the graph");
});
