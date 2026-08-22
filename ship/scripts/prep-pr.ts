#!/usr/bin/env bun

import { $ } from "bun";
import { readdir } from "node:fs/promises";
import { join, dirname } from "node:path";

// ============================================================================
// TYPES
// ============================================================================

type Status = "ok" | "nothing-to-clean" | "no-config" | "error";

type PrepPrResult = {
  status: Status;
  pr_branch: string | null;
  original_branch: string | null;
  backup_ref: string | null;
  removed: string[];
  kept: string[];
  error: string | null;
};

type ShipConfig = {
  strip: {
    patterns: string[];
  };
};

type ParsedArgs = {
  force: boolean;
  backup: boolean;
  dryRun: boolean;
  configPath: string | null;
  prBranch: string | null;
  baseBranch: string;
  specificFiles: string[];
};

// ============================================================================
// PURE FUNCTIONS (exported for testing)
// ============================================================================

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const result: ParsedArgs = {
    force: false,
    backup: false,
    dryRun: false,
    configPath: null,
    prBranch: null,
    baseBranch: "main",
    specificFiles: [],
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--force") {
      result.force = true;
    } else if (arg === "--backup") {
      result.backup = true;
    } else if (arg === "--dry-run") {
      result.dryRun = true;
    } else if (arg === "--config") {
      i++;
      result.configPath = args[i] ?? null;
    } else if (arg === "--pr-branch") {
      i++;
      result.prBranch = args[i] ?? null;
    } else if (arg === "--") {
      result.specificFiles = args.slice(i + 1);
      break;
    } else if (!arg.startsWith("-")) {
      result.baseBranch = arg;
    }
    i++;
  }

  return result;
}

export function derivePrBranch(currentBranch: string, explicit: string | null): string {
  if (explicit) {
    return explicit;
  }
  // If already on a -pr branch, operate on it (don't create -pr-pr)
  if (currentBranch.endsWith("-pr")) {
    return currentBranch;
  }
  return `${currentBranch}-pr`;
}

export function deriveOriginalBranch(currentBranch: string): string {
  // If on a -pr branch, the original is without the suffix
  if (currentBranch.endsWith("-pr")) {
    return currentBranch.slice(0, -3);
  }
  return currentBranch;
}

export function makeResult(overrides: Partial<PrepPrResult>): PrepPrResult {
  return {
    status: "ok",
    pr_branch: null,
    original_branch: null,
    backup_ref: null,
    removed: [],
    kept: [],
    error: null,
    ...overrides,
  };
}

export function errorResult(message: string): PrepPrResult {
  return makeResult({ status: "error", error: message });
}

// ============================================================================
// SIDE-EFFECTING FUNCTIONS
// ============================================================================

async function findConfigFile(startDir: string): Promise<string | null> {
  let dir = startDir;
  while (dir !== dirname(dir)) {
    const candidate = join(dir, ".shiprc.json");
    if (await Bun.file(candidate).exists()) {
      return candidate;
    }
    // Stop at git root (check for .git dir or file via readdir)
    const entries = await readdir(dir).catch(() => []);
    if (entries.includes(".git")) {
      return null;
    }
    dir = dirname(dir);
  }
  return null;
}

function isValidConfig(value: unknown): value is ShipConfig {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.strip !== "object" || obj.strip === null) {
    return false;
  }
  const strip = obj.strip as Record<string, unknown>;
  return Array.isArray(strip.patterns) && strip.patterns.every((p) => typeof p === "string");
}

type ConfigResult =
  | { ok: true; config: ShipConfig }
  | { ok: false; error: string }
  | null; // not found

async function loadConfig(configPath: string | null): Promise<ConfigResult> {
  if (!configPath) {
    return null;
  }
  try {
    const raw: unknown = await Bun.file(configPath).json();
    if (!isValidConfig(raw)) {
      return { ok: false, error: ".shiprc.json is malformed -- expected { strip: { patterns: string[] } }" };
    }
    return { ok: true, config: raw };
  } catch {
    return null;
  }
}

async function getCurrentBranch(): Promise<string | null> {
  const { exitCode, stdout } = await $`git branch --show-current`.quiet().nothrow();
  if (exitCode !== 0) {
    return null;
  }
  const branch = stdout.toString().trim();
  return branch || null;
}

async function isWorkingTreeClean(): Promise<boolean> {
  const { stdout } = await $`git status --porcelain`.quiet().nothrow();
  return stdout.toString().trim() === "";
}

async function branchExists(branch: string): Promise<boolean> {
  const { exitCode } = await $`git show-ref --verify --quiet refs/heads/${branch}`.nothrow().quiet();
  return exitCode === 0;
}

async function getFilesToStrip(
  baseBranch: string,
  patterns: string[],
  specificFiles: string[],
): Promise<string[]> {
  if (specificFiles.length > 0) {
    // Verify specific files are actually in the diff
    const allChanged = await getChangedFiles(baseBranch, patterns);
    return specificFiles.filter((f) => allChanged.includes(f));
  }
  return getChangedFiles(baseBranch, patterns);
}

async function getChangedFiles(baseBranch: string, patterns: string[]): Promise<string[]> {
  const files: string[] = [];
  const range = `${baseBranch}...HEAD`;
  for (const pattern of patterns) {
    const { stdout } = await $`git diff --name-only ${range} -- ${pattern}`
      .quiet()
      .nothrow();
    const lines = stdout
      .toString()
      .trim()
      .split("\n")
      .filter((l) => l.length > 0);
    files.push(...lines);
  }
  return files;
}

async function createBackup(prBranch: string): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const backupRef = `backup/ship-${timestamp}`;
  await $`git branch ${backupRef} ${prBranch}`.quiet();
  return backupRef;
}

async function run(args: ParsedArgs): Promise<PrepPrResult> {
  // 1. Get current branch
  const currentBranch = await getCurrentBranch();
  if (!currentBranch) {
    return errorResult("not on a branch (detached HEAD?)");
  }

  // 2. Check working tree
  if (!(await isWorkingTreeClean())) {
    return errorResult("working tree is dirty -- commit or stash first");
  }

  // 3. Load config
  const configPath = args.configPath ?? (await findConfigFile(process.cwd()));
  const configResult = await loadConfig(configPath);
  if (configResult === null) {
    return makeResult({
      status: "no-config",
      original_branch: currentBranch,
      error: "no .shiprc.json found",
    });
  }
  if (!configResult.ok) {
    return errorResult(configResult.error);
  }
  const config = configResult.config;

  // When --pr-branch is explicit, don't guess the original -- it's the current branch
  const originalBranch = args.prBranch ? currentBranch : deriveOriginalBranch(currentBranch);
  const prBranch = derivePrBranch(currentBranch, args.prBranch);

  // 3b. Validate derived original branch exists (guards against false -pr suffix match)
  if (originalBranch !== currentBranch && !(await branchExists(originalBranch))) {
    return errorResult(
      `cannot derive original branch '${originalBranch}' from '${currentBranch}' -- use --pr-branch to specify explicitly`,
    );
  }

  // 4. Handle existing -pr branch
  const prExists = await branchExists(prBranch);
  if (prExists && !args.force) {
    return errorResult(
      `branch '${prBranch}' already exists -- use --force to recreate`,
    );
  }

  // 5. Find files to strip
  const filesToStrip = await getFilesToStrip(
    args.baseBranch,
    config.strip.patterns,
    args.specificFiles,
  );

  if (filesToStrip.length === 0) {
    return makeResult({
      status: "nothing-to-clean",
      original_branch: originalBranch,
      pr_branch: null,
    });
  }

  // Compute kept files: all changed files matching patterns minus stripped
  const allMatchingFiles = await getChangedFiles(args.baseBranch, config.strip.patterns);
  const kept = allMatchingFiles.filter((f) => !filesToStrip.includes(f));

  // 6. Dry-run: stop here
  if (args.dryRun) {
    return makeResult({
      status: "ok",
      original_branch: originalBranch,
      pr_branch: prBranch,
      removed: filesToStrip,
      kept,
    });
  }

  // 7. Backup existing -pr branch before deleting
  let backupRef: string | null = null;
  if (prExists && args.backup) {
    backupRef = await createBackup(prBranch);
  }

  // 8. Delete existing -pr branch if force (skip if we're on it)
  if (prExists && currentBranch !== prBranch) {
    await $`git branch -D ${prBranch}`.quiet();
  }

  // 9. Create or reset -pr branch
  if (currentBranch === prBranch) {
    // Already on the -pr branch (re-strip case): reset to feature branch HEAD
    const featureHead = await $`git rev-parse ${originalBranch}`.text();
    await $`git reset --hard ${featureHead.trim()}`.quiet();
  } else {
    await $`git checkout -b ${prBranch}`.quiet();
  }

  // 10. Remove files and commit
  try {
    await $`git rm -q ${filesToStrip}`.quiet();
    await $`git commit -m "Remove working files (plans, specs, notes) for PR"`.quiet();
  } catch (e) {
    // Rollback: return to original branch, delete the -pr branch
    await $`git checkout ${originalBranch}`.quiet().nothrow();
    if (currentBranch !== prBranch) {
      await $`git branch -D ${prBranch}`.quiet().nothrow();
    }
    const message = e instanceof Error ? e.message : String(e);
    return errorResult(`git rm/commit failed: ${message}`);
  }

  // 11. Return to original branch (skip if we started on -pr)
  if (currentBranch !== prBranch) {
    await $`git checkout ${originalBranch}`.quiet();
  }

  return makeResult({
    status: "ok",
    original_branch: originalBranch,
    pr_branch: prBranch,
    backup_ref: backupRef,
    removed: filesToStrip,
    kept,
  });
}

// ============================================================================
// CLI ENTRY POINT
// ============================================================================

if (import.meta.main) {
  const args = parseArgs(Bun.argv);

  try {
    const result = await run(args);
    console.log(JSON.stringify(result, null, 2));

    if (result.status === "error") {
      process.exit(1);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.log(JSON.stringify(errorResult(message), null, 2));
    process.exit(1);
  }
}
