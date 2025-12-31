import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(__dirname, "..", "validate-marketplace.ts");
const fixturesDir = join(__dirname, "fixtures");

/**
 * Helper to set up a test environment with a fixture
 */
async function setupTestRepo(fixtureName: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "validate-marketplace-test-"));

  // Copy fixture to temp directory
  await cp(join(fixturesDir, fixtureName), tempDir, { recursive: true });

  // Initialize git repo (required by the script)
  await $`git init`.cwd(tempDir).quiet();

  return tempDir;
}

/**
 * Helper to run the validation script in a directory
 */
async function runValidation(cwd: string) {
  const result = await $`bun ${scriptPath}`.cwd(cwd).nothrow().quiet();
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("validate-marketplace CLI", () => {
  const tempDirs: string[] = [];

  afterAll(async () => {
    // Clean up all temp directories
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("exits 0 for valid marketplace", async () => {
    const tempDir = await setupTestRepo("valid");
    tempDirs.push(tempDir);

    const result = await runValidation(tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("All checks passed");
    expect(result.stdout).toContain("Name matches");
    expect(result.stdout).toContain("Version synced");
    expect(result.stdout).toContain("Required fields present");
  });

  test("exits 1 for version mismatch", async () => {
    const tempDir = await setupTestRepo("version-mismatch");
    tempDirs.push(tempDir);

    const result = await runValidation(tempDir);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Version mismatch");
    expect(result.stdout).toContain("marketplace=2.0.0");
    expect(result.stdout).toContain("plugin=1.0.0");
  });

  test("exits 1 for missing required fields", async () => {
    const tempDir = await setupTestRepo("missing-fields");
    tempDirs.push(tempDir);

    const result = await runValidation(tempDir);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Missing fields");
    expect(result.stdout).toContain("marketplace:description");
    expect(result.stdout).toContain("plugin:version");
    expect(result.stdout).toContain("plugin:description");
  });

  test("exits 1 for README version mismatch", async () => {
    const tempDir = await setupTestRepo("readme-mismatch");
    tempDirs.push(tempDir);

    const result = await runValidation(tempDir);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("README version mismatch");
    expect(result.stdout).toContain("plugin-a");
    expect(result.stdout).toContain("1.0.0");
    expect(result.stdout).toContain("2.0.0");
  });

  test("exits 2 when not in a git repo", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "validate-marketplace-test-"));
    tempDirs.push(tempDir);

    const result = await runValidation(tempDir);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Not in a git repository");
  });

  test("exits 2 when marketplace.json is missing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "validate-marketplace-test-"));
    tempDirs.push(tempDir);

    // Initialize git but don't create marketplace.json
    await $`git init`.cwd(tempDir).quiet();

    const result = await runValidation(tempDir);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("not found");
  });
});
