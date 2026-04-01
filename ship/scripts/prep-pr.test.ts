import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

import { deriveOriginalBranch, derivePrBranch, errorResult, makeResult, parseArgs } from "./prep-pr";

// ============================================================================
// HELPERS
// ============================================================================

const SCRIPT_PATH = existsSync(join(import.meta.dir, "prep-pr"))
  ? join(import.meta.dir, "prep-pr")
  : join(import.meta.dir, "executable_prep-pr");

async function createTempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "prep-pr-test-"));
  await $`git init -b main ${dir}`.quiet();
  await $`git -C ${dir} config user.email "test@test.com"`.quiet();
  await $`git -C ${dir} config user.name "Test"`.quiet();
  // Create initial commit on main
  await writeFile(join(dir, "README.md"), "# Test repo\n");
  await $`git -C ${dir} add README.md`.quiet();
  await $`git -C ${dir} commit -m "Initial commit"`.quiet();
  return dir;
}

async function addShipConfig(dir: string, patterns: string[] = ["plans/", "docs/"]): Promise<void> {
  const config = { strip: { patterns } };
  await writeFile(join(dir, ".shiprc.json"), JSON.stringify(config, null, 2));
  await $`git -C ${dir} add .shiprc.json`.quiet();
  await $`git -C ${dir} commit -m "Add .shiprc.json"`.quiet();
}

async function createFeatureBranch(dir: string, branchName: string, files: Record<string, string>): Promise<void> {
  await $`git -C ${dir} checkout -b ${branchName}`.quiet();
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(dir, path);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content);
  }
  const filePaths = Object.keys(files);
  await $`git -C ${dir} add ${filePaths}`.cwd(dir).quiet();
  await $`git -C ${dir} commit -m "Add feature files"`.quiet();
}

type PrepPrResult = {
  status: string;
  pr_branch: string | null;
  original_branch: string | null;
  backup_ref: string | null;
  removed: string[];
  kept: string[];
  error: string | null;
};

async function runPrepPr(dir: string, args: string[] = []): Promise<PrepPrResult> {
  const proc = Bun.spawn(["bun", SCRIPT_PATH, ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return JSON.parse(stdout);
}

async function branchExists(dir: string, branch: string): Promise<boolean> {
  const { exitCode } = await $`git -C ${dir} show-ref --verify --quiet refs/heads/${branch}`.nothrow().quiet();
  return exitCode === 0;
}

// ============================================================================
// UNIT TESTS: PURE FUNCTIONS
// ============================================================================

describe("parseArgs", () => {
  test("defaults to main base branch", () => {
    const result = parseArgs(["bun", "script.ts"]);
    expect(result.baseBranch).toBe("main");
    expect(result.force).toBe(false);
    expect(result.backup).toBe(false);
    expect(result.dryRun).toBe(false);
    expect(result.specificFiles).toEqual([]);
  });

  test("parses all flags", () => {
    const result = parseArgs(["bun", "script.ts", "--force", "--backup", "--dry-run"]);
    expect(result.force).toBe(true);
    expect(result.backup).toBe(true);
    expect(result.dryRun).toBe(true);
  });

  test("parses base branch", () => {
    const result = parseArgs(["bun", "script.ts", "develop"]);
    expect(result.baseBranch).toBe("develop");
  });

  test("parses specific files after --", () => {
    const result = parseArgs(["bun", "script.ts", "--", "plans/a.md", "docs/b.md"]);
    expect(result.specificFiles).toEqual(["plans/a.md", "docs/b.md"]);
  });

  test("parses config path", () => {
    const result = parseArgs(["bun", "script.ts", "--config", "/tmp/.shiprc.json"]);
    expect(result.configPath).toBe("/tmp/.shiprc.json");
  });

  test("combines flags, branch, and files", () => {
    const result = parseArgs(["bun", "script.ts", "--force", "--backup", "develop", "--", "plans/x.md"]);
    expect(result.force).toBe(true);
    expect(result.backup).toBe(true);
    expect(result.baseBranch).toBe("develop");
    expect(result.specificFiles).toEqual(["plans/x.md"]);
  });
});

describe("makeResult / errorResult", () => {
  test("makeResult fills defaults", () => {
    const result = makeResult({ status: "ok" });
    expect(result.pr_branch).toBeNull();
    expect(result.removed).toEqual([]);
    expect(result.error).toBeNull();
  });

  test("errorResult sets status and message", () => {
    const result = errorResult("something broke");
    expect(result.status).toBe("error");
    expect(result.error).toBe("something broke");
  });
});

// ============================================================================
// INTEGRATION TESTS
// ============================================================================

describe("prep-pr integration", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempRepo();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("strips all matching files", async () => {
    await addShipConfig(dir);
    await createFeatureBranch(dir, "feature/test", {
      "plans/notes.md": "# Notes",
      "docs/spec.md": "# Spec",
      "src/code.ts": "export const x = 1;",
    });

    const result = await runPrepPr(dir, ["--force"]);

    expect(result.status).toBe("ok");
    expect(result.original_branch).toBe("feature/test");
    expect(result.pr_branch).toBe("feature/test-pr");
    expect(result.removed).toContain("plans/notes.md");
    expect(result.removed).toContain("docs/spec.md");
    expect(result.removed).not.toContain("src/code.ts");

    // Verify -pr branch was created
    expect(await branchExists(dir, "feature/test-pr")).toBe(true);

    // Verify we're back on the original branch
    const branch = await $`git -C ${dir} branch --show-current`.text();
    expect(branch.trim()).toBe("feature/test");
  });

  test("strips only specific files when passed after --", async () => {
    await addShipConfig(dir);
    await createFeatureBranch(dir, "feature/selective", {
      "plans/keep-me.md": "# Keep",
      "plans/remove-me.md": "# Remove",
      "src/code.ts": "export const x = 1;",
    });

    const result = await runPrepPr(dir, ["--force", "--", "plans/remove-me.md"]);

    expect(result.status).toBe("ok");
    expect(result.removed).toEqual(["plans/remove-me.md"]);
    expect(result.kept).toContain("plans/keep-me.md");
  });

  test("returns nothing-to-clean when no matching files", async () => {
    await addShipConfig(dir);
    await createFeatureBranch(dir, "feature/clean", {
      "src/code.ts": "export const x = 1;",
    });

    const result = await runPrepPr(dir);

    expect(result.status).toBe("nothing-to-clean");
    expect(result.pr_branch).toBeNull();
    // No -pr branch should exist
    expect(await branchExists(dir, "feature/clean-pr")).toBe(false);
  });

  test("dry-run does not create branch or modify anything", async () => {
    await addShipConfig(dir);
    await createFeatureBranch(dir, "feature/dry", {
      "plans/notes.md": "# Notes",
      "src/code.ts": "export const x = 1;",
    });

    const result = await runPrepPr(dir, ["--dry-run"]);

    expect(result.status).toBe("ok");
    expect(result.removed).toContain("plans/notes.md");
    expect(result.pr_branch).toBe("feature/dry-pr");

    // Branch should NOT exist
    expect(await branchExists(dir, "feature/dry-pr")).toBe(false);
  });

  test("refuses if -pr branch exists without --force", async () => {
    await addShipConfig(dir);
    await createFeatureBranch(dir, "feature/existing", {
      "plans/notes.md": "# Notes",
    });
    // Create the -pr branch manually
    await $`git -C ${dir} branch feature/existing-pr`.quiet();

    const result = await runPrepPr(dir);

    expect(result.status).toBe("error");
    expect(result.error).toContain("already exists");
    expect(result.error).toContain("--force");
  });

  test("force recreates -pr branch when it exists", async () => {
    await addShipConfig(dir);
    await createFeatureBranch(dir, "feature/recreate", {
      "plans/notes.md": "# Notes",
    });
    // Create a stale -pr branch
    await $`git -C ${dir} branch feature/recreate-pr`.quiet();

    const result = await runPrepPr(dir, ["--force"]);

    expect(result.status).toBe("ok");
    expect(result.pr_branch).toBe("feature/recreate-pr");
    expect(result.removed).toContain("plans/notes.md");
  });

  test("creates backup when --backup and -pr branch exists", async () => {
    await addShipConfig(dir);
    await createFeatureBranch(dir, "feature/backup", {
      "plans/notes.md": "# Notes",
    });
    // Create existing -pr branch to be backed up
    await $`git -C ${dir} branch feature/backup-pr`.quiet();

    const result = await runPrepPr(dir, ["--force", "--backup"]);

    expect(result.status).toBe("ok");
    expect(result.backup_ref).toBeTruthy();
    expect(result.backup_ref).toMatch(/^backup\/ship-\d+$/);

    // Verify backup branch exists
    const ref = result.backup_ref ?? "";
    expect(await branchExists(dir, ref)).toBe(true);
  });

  test("returns no-config when .shiprc.json is missing", async () => {
    // No addShipConfig call -- create branch with a committed file
    await $`git -C ${dir} checkout -b feature/no-config`.quiet();
    await mkdir(join(dir, "plans"), { recursive: true });
    await writeFile(join(dir, "plans/notes.md"), "# Notes");
    await $`git -C ${dir} add plans/notes.md`.quiet();
    await $`git -C ${dir} commit -m "Add notes"`.quiet();

    const result = await runPrepPr(dir);

    expect(result.status).toBe("no-config");
    expect(result.error).toContain(".shiprc.json");
  });

  test("returns error on detached HEAD", async () => {
    await addShipConfig(dir);
    // Detach HEAD
    const { stdout } = await $`git -C ${dir} rev-parse HEAD`.quiet();
    await $`git -C ${dir} checkout ${stdout.toString().trim()}`.quiet();

    const result = await runPrepPr(dir);

    expect(result.status).toBe("error");
    expect(result.error).toContain("detached HEAD");
  });

  test("returns error on dirty working tree", async () => {
    await addShipConfig(dir);
    await createFeatureBranch(dir, "feature/dirty", {
      "plans/notes.md": "# Notes",
    });
    // Make working tree dirty
    await writeFile(join(dir, "dirty.txt"), "uncommitted");

    const result = await runPrepPr(dir);

    expect(result.status).toBe("error");
    expect(result.error).toContain("dirty");
  });

  test("returns error on malformed .shiprc.json", async () => {
    // Write invalid config (missing strip.patterns)
    await writeFile(join(dir, ".shiprc.json"), '{"wrong": true}');
    await $`git -C ${dir} add .shiprc.json`.quiet();
    await $`git -C ${dir} commit -m "Add bad config"`.quiet();
    await $`git -C ${dir} checkout -b feature/bad-config`.quiet();

    const result = await runPrepPr(dir);

    expect(result.status).toBe("error");
    expect(result.error).toContain("malformed");
  });

  test("re-strip from -pr branch does not create -pr-pr", async () => {
    await addShipConfig(dir);
    await createFeatureBranch(dir, "feature/restrip", {
      "plans/notes.md": "# Notes",
      "src/code.ts": "export const x = 1;",
    });

    // First strip: create the -pr branch
    const first = await runPrepPr(dir, ["--force"]);
    expect(first.status).toBe("ok");
    expect(first.pr_branch).toBe("feature/restrip-pr");

    // Simulate being on the -pr branch for re-strip
    await $`git -C ${dir} checkout feature/restrip-pr`.quiet();

    // Add back a file to simulate changes since first strip
    await $`git -C ${dir} checkout feature/restrip -- plans/notes.md`.quiet();
    await $`git -C ${dir} commit -m "Restore file for re-strip test"`.quiet();

    const result = await runPrepPr(dir, ["--force"]);

    expect(result.status).toBe("ok");
    // Should target feature/restrip-pr, NOT feature/restrip-pr-pr
    expect(result.pr_branch).toBe("feature/restrip-pr");
    expect(result.original_branch).toBe("feature/restrip");
    expect(result.removed).toContain("plans/notes.md");
  });

  test("--pr-branch overrides auto-derived name", async () => {
    await addShipConfig(dir);
    await createFeatureBranch(dir, "feature/custom", {
      "plans/notes.md": "# Notes",
    });

    const result = await runPrepPr(dir, ["--force", "--pr-branch", "custom-clean"]);

    expect(result.status).toBe("ok");
    expect(result.pr_branch).toBe("custom-clean");
    expect(await branchExists(dir, "custom-clean")).toBe(true);
  });

  // ==========================================================================
  // EDGE CASES
  // ==========================================================================

  test("--pr-branch without --force fails when branch exists", async () => {
    await addShipConfig(dir);
    await createFeatureBranch(dir, "feature/clash", {
      "plans/notes.md": "# Notes",
    });
    await $`git -C ${dir} branch custom-clean`.quiet();

    const result = await runPrepPr(dir, ["--pr-branch", "custom-clean"]);

    expect(result.status).toBe("error");
    expect(result.error).toContain("already exists");
  });

  test("dry-run blocked when PR branch exists without --force", async () => {
    await addShipConfig(dir);
    await createFeatureBranch(dir, "feature/dryblock", {
      "plans/notes.md": "# Notes",
    });
    await $`git -C ${dir} branch feature/dryblock-pr`.quiet();

    const result = await runPrepPr(dir, ["--dry-run"]);

    // Current behavior: --dry-run does NOT bypass the --force check
    expect(result.status).toBe("error");
    expect(result.error).toContain("already exists");
  });

  test("empty patterns array returns nothing-to-clean", async () => {
    await addShipConfig(dir, []);
    await createFeatureBranch(dir, "feature/empty-patterns", {
      "plans/notes.md": "# Notes",
      "src/code.ts": "export const x = 1;",
    });

    const result = await runPrepPr(dir);

    expect(result.status).toBe("nothing-to-clean");
    expect(result.pr_branch).toBeNull();
  });

  test("malformed config: strip is a string instead of object", async () => {
    await writeFile(join(dir, ".shiprc.json"), '{"strip": "wrong"}');
    await $`git -C ${dir} add .shiprc.json`.quiet();
    await $`git -C ${dir} commit -m "Add bad config"`.quiet();
    await $`git -C ${dir} checkout -b feature/bad-strip`.quiet();

    const result = await runPrepPr(dir);

    expect(result.status).toBe("error");
    expect(result.error).toContain("malformed");
  });

  test("malformed config: patterns contains non-strings", async () => {
    await writeFile(join(dir, ".shiprc.json"), '{"strip": {"patterns": [123, true]}}');
    await $`git -C ${dir} add .shiprc.json`.quiet();
    await $`git -C ${dir} commit -m "Add bad config"`.quiet();
    await $`git -C ${dir} checkout -b feature/bad-patterns`.quiet();

    const result = await runPrepPr(dir);

    expect(result.status).toBe("error");
    expect(result.error).toContain("malformed");
  });

  test("malformed config: null JSON", async () => {
    await writeFile(join(dir, ".shiprc.json"), "null");
    await $`git -C ${dir} add .shiprc.json`.quiet();
    await $`git -C ${dir} commit -m "Add null config"`.quiet();
    await $`git -C ${dir} checkout -b feature/null-config`.quiet();

    const result = await runPrepPr(dir);

    expect(result.status).toBe("error");
    expect(result.error).toContain("malformed");
  });

  test("re-strip with --backup creates backup before reset", async () => {
    await addShipConfig(dir);
    await createFeatureBranch(dir, "feature/restrip-bk", {
      "plans/notes.md": "# Notes",
      "src/code.ts": "export const x = 1;",
    });

    // First strip
    await runPrepPr(dir, ["--force"]);

    // Go to -pr branch and restore a file
    await $`git -C ${dir} checkout feature/restrip-bk-pr`.quiet();
    await $`git -C ${dir} checkout feature/restrip-bk -- plans/notes.md`.quiet();
    await $`git -C ${dir} commit -m "Restore file"`.quiet();

    // Re-strip with backup
    const result = await runPrepPr(dir, ["--force", "--backup"]);

    expect(result.status).toBe("ok");
    expect(result.backup_ref).toBeTruthy();
    expect(result.backup_ref).toMatch(/^backup\/ship-\d+$/);
    const ref = result.backup_ref ?? "";
    expect(await branchExists(dir, ref)).toBe(true);
  });

  test("branch ending in -pr without matching original fails with clear error", async () => {
    await addShipConfig(dir);
    // Create a branch that looks like a -pr branch but isn't one
    await createFeatureBranch(dir, "feature/fix-pr", {
      "plans/notes.md": "# Notes",
    });

    // derivePrBranch thinks this IS a PR branch, deriveOriginalBranch produces "feature/fi"
    // The validation in run() should catch that "feature/fi" doesn't exist
    const result = await runPrepPr(dir, ["--force"]);

    expect(result.status).toBe("error");
    expect(result.error).toContain("cannot derive original branch");
    expect(result.error).toContain("feature/fi");
  });

  test("false -pr suffix with --pr-branch override succeeds", async () => {
    await addShipConfig(dir);
    await createFeatureBranch(dir, "feature/fix-pr", {
      "plans/notes.md": "# Notes",
    });

    // Explicitly set the PR branch to bypass the broken derivation
    // When --pr-branch is explicit, originalBranch = currentBranch (no naive stripping)
    const result = await runPrepPr(dir, ["--force", "--pr-branch", "feature/fix-pr-clean"]);

    expect(result.status).toBe("ok");
    expect(result.pr_branch).toBe("feature/fix-pr-clean");
    expect(result.original_branch).toBe("feature/fix-pr");
  });
});

// ============================================================================
// UNIT TESTS: NEW PURE FUNCTIONS
// ============================================================================

describe("derivePrBranch", () => {
  test("appends -pr to feature branch", () => {
    expect(derivePrBranch("feature/foo", null)).toBe("feature/foo-pr");
  });

  test("does not double-suffix -pr branch", () => {
    expect(derivePrBranch("feature/foo-pr", null)).toBe("feature/foo-pr");
  });

  test("explicit override wins", () => {
    expect(derivePrBranch("feature/foo", "custom-branch")).toBe("custom-branch");
  });

  test("branch ending in -pr that is not a PR branch gets -pr appended naively", () => {
    // derivePrBranch can't distinguish -- the validation in run() catches this
    expect(derivePrBranch("feature/fix-pr", null)).toBe("feature/fix-pr");
  });

  test("branch with -pr in the middle is not treated as PR branch", () => {
    expect(derivePrBranch("feature/pr-helper", null)).toBe("feature/pr-helper-pr");
  });
});

describe("deriveOriginalBranch", () => {
  test("strips -pr suffix", () => {
    expect(deriveOriginalBranch("feature/foo-pr")).toBe("feature/foo");
  });

  test("returns as-is if no -pr suffix", () => {
    expect(deriveOriginalBranch("feature/foo")).toBe("feature/foo");
  });

  test("naive strip on ambiguous branch name (validated in run())", () => {
    // deriveOriginalBranch("feature/fix-pr") -> "feature/fix" -- wrong but caught by run()
    expect(deriveOriginalBranch("feature/fix-pr")).toBe("feature/fix");
  });
});
