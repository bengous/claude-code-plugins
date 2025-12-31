#!/usr/bin/env bun
/**
 * Marketplace validation script
 * Validates marketplace.json against individual plugin.json files
 */

import { $ } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  validateNameMatch,
  validateVersionSync,
  validateRequiredFields,
  extractVersionFromReadme,
  validateReadmeVersion,
  type PluginEntry,
  type PluginJson,
  type ValidationResult,
} from "./lib/marketplace-validation";

// Colors (disabled if not a terminal)
const isTTY = process.stdout.isTTY;
const GREEN = isTTY ? "\x1b[0;32m" : "";
const RED = isTTY ? "\x1b[0;31m" : "";
const BOLD = isTTY ? "\x1b[1m" : "";
const RESET = isTTY ? "\x1b[0m" : "";

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

  // Check 5: Required fields present
  report(validateRequiredFields(mp, pluginJson));

  console.log();
}

// Check README.md versions match marketplace.json
if (existsSync(readmeFile)) {
  console.log(`${BOLD}README.md${RESET}`);

  const readmeContent = await Bun.file(readmeFile).text();
  let readmeErrors = 0;

  for (const mp of marketplace.plugins) {
    if (!mp.version) continue;

    const readmeVersion = extractVersionFromReadme(readmeContent, mp.name);
    if (readmeVersion) {
      const result = validateReadmeVersion(readmeVersion, mp.version, mp.name);
      if (!result.passed) {
        fail(result.message);
        readmeErrors++;
      }
    }
  }

  if (readmeErrors === 0) {
    pass("Versions match marketplace.json");
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
