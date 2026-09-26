#!/usr/bin/env bun
/**
 * Marketplace validation script
 * Validates marketplace.json against individual plugin.json files
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { $ } from "bun";

import { CHANGELOG, changelogVerdict, versionCommits } from "./changelog.ts";
import { commitAt, sourceDirOf, type Version } from "./check-plugin-bumps.ts";
import {
  validateNameMatch,
  validateVersionSync,
  validateDescriptionSync,
  validateRequiredFields,
  validatePluginDirContents,
  findHardcodedPaths,
  extractVersionFromReadme,
  validateReadmeVersion,
  extractDescriptionFromReadme,
  validateReadmeDescription,
  type PluginEntry,
  type PluginJson,
  type ValidationResult,
} from "./lib/marketplace-validation";
import { pluginDirAt } from "./lib/plugin-sources.ts";

// Colors (disabled if not a terminal)
const isTTY = process.stdout.isTTY;

const GREEN = isTTY ? "\u001B[0;32m" : "";

const RED = isTTY ? "\u001B[0;31m" : "";

const BOLD = isTTY ? "\u001B[1m" : "";

const RESET = isTTY ? "\u001B[0m" : "";

let errors = 0;

const pass = (msg: string) => console.log(`  ${GREEN}✓${RESET} ${msg}`);

const fail = (msg: string) => {
  console.log(`  ${RED}✗${RESET} ${msg}`);
  errors++;
};

const report = (result: ValidationResult) => {
  if (result.passed) {
    pass(result.message);
  } else {
    fail(result.message);
  }
};

// Get repo root
const repoRootResult = await $`git rev-parse --show-toplevel`.nothrow().quiet();

if (repoRootResult.exitCode !== 0) {
  console.error("Error: Not in a git repository");
  process.exit(2);
}

const repoRoot = repoRootResult.text().trim();

const marketplaceFile = join(repoRoot, ".claude-plugin/marketplace.json");

const readmeFile = join(repoRoot, "README.md");

// Check marketplace.json exists
if (!existsSync(marketplaceFile)) {
  console.error(`Error: ${marketplaceFile} not found`);
  process.exit(2);
}

// Load and validate marketplace.json
interface Marketplace {
  plugins: PluginEntry[];
}

let marketplace: Marketplace;

try {
  marketplace = await Bun.file(marketplaceFile).json();
} catch {
  console.error(`Error: ${marketplaceFile} is not valid JSON`);
  process.exit(2);
}

// Shipped plugin code, listed once and filtered per plugin below. Only what git
// tracks ships, so an untracked scratch file is not the marketplace's problem.
const trackedFiles = (await $`git ls-files -z`.quiet().text()).split("\0").filter(Boolean);

const SHIPPED_TEXT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".sh",
  ".md",
  ".json",
  ".js",
  ".mjs",
  ".cjs",
  ".html",
  ".css",
];

const isShippedText = (path: string) => SHIPPED_TEXT_EXTENSIONS.some((ext) => path.endsWith(ext));

/** Where the missing section's commits start: the commit that set the plugin's last committed version. */
function sinceHint(source: string): string {
  const repo = pluginDirAt(repoRoot);

  if (repo === null) return "";

  const dir = sourceDirOf(source, "marketplace.json");
  const last = versionCommits(repo, dir, commitAt(repo, "HEAD")).at(-1);

  return last === undefined
    ? ""
    : `; the commits to cover: git log ${last.commit.slice(0, 8)}..HEAD -- ${dir}`;
}

console.log(`${BOLD}Validating marketplace plugins...${RESET}\n`);

// Validate each plugin
for (const mp of marketplace.plugins) {
  console.log(`${BOLD}${mp.name}${RESET}`);

  // Check 1: Plugin directory exists
  const pluginDir = join(repoRoot, mp.source);

  if (existsSync(pluginDir)) {
    pass(`Directory exists: ${mp.source}`);
  } else {
    fail(`Directory missing: ${mp.source}`);
    console.log();
    continue;
  }

  // Check 2: plugin.json exists
  const pluginJsonPath = join(pluginDir, ".claude-plugin/plugin.json");

  if (existsSync(pluginJsonPath)) {
    pass("plugin.json exists");
  } else {
    fail(`plugin.json missing: ${pluginJsonPath}`);
    console.log();
    continue;
  }

  // Load plugin.json
  let pluginJson: PluginJson;

  try {
    pluginJson = await Bun.file(pluginJsonPath).json();
  } catch {
    fail("plugin.json is not valid JSON");
    console.log();
    continue;
  }

  // Check 3: Name matches
  report(validateNameMatch(mp.name, pluginJson.name));

  // Check 4: Version synced
  report(validateVersionSync(mp.version, pluginJson.version));

  // Check 5: Description synced
  report(validateDescriptionSync(mp.description, pluginJson.description));

  // Check 6: Required fields present
  report(validateRequiredFields(mp, pluginJson));

  // Check 7: .claude-plugin/ holds nothing but plugin.json
  report(validatePluginDirContents(readdirSync(join(pluginDir, ".claude-plugin"))));

  // Check 8: no machine-specific home paths in shipped code
  const prefix = `${mp.source.replace(/^\.\//u, "")}/`;
  let hardcoded = 0;

  for (const file of trackedFiles) {
    if (!file.startsWith(prefix) || !isShippedText(file)) continue;
    const content = await Bun.file(join(repoRoot, file)).text();

    for (const hit of findHardcodedPaths(content)) {
      fail(`Hardcoded path: ${file}:${hit.line}: ${hit.text}`);
      hardcoded++;
    }
  }

  if (hardcoded === 0) {
    pass("No hardcoded paths");
  }

  // Check 9: a plugin that keeps a changelog has a section for its version
  const changelogPath = join(pluginDir, CHANGELOG);

  if (existsSync(changelogPath) && pluginJson.version) {
    // SAFETY: the brand states a non-empty version, checked by the condition above.
    const version = pluginJson.version as Version;

    const verdict = changelogVerdict(
      `${prefix}${CHANGELOG}`,
      await Bun.file(changelogPath).text(),
      version,
    );

    if (verdict.passed) {
      pass(verdict.message);
    } else {
      fail(`${verdict.message}${sinceHint(mp.source)}`);
    }
  }

  console.log();
}

// Check README.md versions and descriptions match marketplace.json
if (existsSync(readmeFile)) {
  console.log(`${BOLD}README.md${RESET}`);

  const readmeContent = await Bun.file(readmeFile).text();
  let versionErrors = 0;
  let descriptionErrors = 0;

  for (const mp of marketplace.plugins) {
    if (mp.version) {
      const readmeVersion = extractVersionFromReadme(readmeContent, mp.name);

      if (readmeVersion) {
        const result = validateReadmeVersion(readmeVersion, mp.version, mp.name);

        if (!result.passed) {
          fail(result.message);
          versionErrors++;
        }
      }
    }

    if (!mp.description) continue;

    const readmeDescription = extractDescriptionFromReadme(readmeContent, mp.name);

    if (readmeDescription === null) continue;

    const result = validateReadmeDescription(readmeDescription, mp.description, mp.name);

    if (!result.passed) {
      fail(result.message);
      descriptionErrors++;
    }
  }

  if (versionErrors === 0) {
    pass("Versions match marketplace.json");
  }

  if (descriptionErrors === 0) {
    pass("Descriptions match marketplace.json");
  }

  console.log();
}

// Summary
console.log("─────────────────────────────");

if (errors === 0) {
  console.log(`${GREEN}All checks passed.${RESET}`);
  process.exit(0);
} else {
  console.log(`${RED}${errors} error(s) found.${RESET}`);
  process.exit(1);
}
