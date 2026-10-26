import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

const testDir = import.meta.dirname;

const scriptPath = join(testDir, "..", "sync-versions.ts");

const fixturesDir = join(testDir, "fixtures");

async function setupTestRepo(fixtureName: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "sync-versions-test-"));

  await cp(join(fixturesDir, fixtureName), tempDir, { recursive: true });
  await $`git init -q`.cwd(tempDir).quiet();

  return tempDir;
}

async function runSync(cwd: string) {
  const result = await $`bun ${scriptPath}`.cwd(cwd).nothrow().quiet();

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

const marketplaceDescription = async (repo: string) =>
  (await Bun.file(join(repo, ".claude-plugin/marketplace.json")).json()).plugins[0].description;

const readme = async (repo: string) => await Bun.file(join(repo, "README.md")).text();

describe("sync-versions CLI", () => {
  const tempDirs: string[] = [];

  afterAll(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("propagates a description changed in plugin.json alone", async () => {
    const tempDir = await setupTestRepo("description-drift");
    tempDirs.push(tempDir);

    const result = await runSync(tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("plugin-a: marketplace.json description");
    expect(result.stdout).toContain("plugin-a: README.md description");
    expect(await marketplaceDescription(tempDir)).toBe("The blurb plugin.json carries");
    expect(await readme(tempDir)).toContain(
      "| [plugin-a](plugin-a/) | 1.0.0 | The blurb plugin.json carries |",
    );
  });

  test("writes the table row, not the header a prose link matches first", async () => {
    const tempDir = await setupTestRepo("description-drift");
    tempDirs.push(tempDir);

    await runSync(tempDir);
    const content = await readme(tempDir);

    expect(content).toContain("| Plugin | Version | Description |");
    expect(content).toContain("Start with [plugin-a](plugin-a/), the core one.");
    expect(content).not.toContain("A staler README blurb");
  });

  test("a second run reports nothing left to sync", async () => {
    const tempDir = await setupTestRepo("description-drift");
    tempDirs.push(tempDir);

    await runSync(tempDir);
    const second = await runSync(tempDir);

    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("already in sync");
  });

  test("refuses a description holding a pipe and writes nothing", async () => {
    const tempDir = await setupTestRepo("description-pipe");
    tempDirs.push(tempDir);

    const before = await readme(tempDir);
    const result = await runSync(tempDir);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("plugin-a");
    expect(result.stderr).toContain("README table cell");
    expect(await marketplaceDescription(tempDir)).toBe("An older blurb");
    expect(await readme(tempDir)).toBe(before);
  });
});
