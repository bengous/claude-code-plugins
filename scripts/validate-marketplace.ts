#!/usr/bin/env bun
/**
 * Marketplace validation script
 * Validates marketplace.json against individual plugin.json files
 */

import { $ } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";

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

// Get repo root
const repoRootResult = await $`git rev-parse --show-toplevel`.quiet();
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
interface PluginEntry {
  name: string;
  source: string;
  version?: string;
  description?: string;
}

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
  interface PluginJson {
    name?: string;
    version?: string;
    description?: string;
  }

  let pluginJson: PluginJson;
  try {
    pluginJson = await Bun.file(pluginJsonPath).json();
  } catch {
    fail("plugin.json is not valid JSON");
    console.log();
    continue;
  }

  // Check 3: Name matches
  if (mp.name === pluginJson.name) {
    pass("Name matches");
  } else {
    fail(`Name mismatch: marketplace=${mp.name}, plugin=${pluginJson.name}`);
  }

  // Check 4: Version synced
  if (!mp.version) {
    fail("Version missing in marketplace.json");
  } else if (!pluginJson.version) {
    fail("Version missing in plugin.json");
  } else if (mp.version === pluginJson.version) {
    pass(`Version synced (${mp.version})`);
  } else {
    fail(`Version mismatch: marketplace=${mp.version}, plugin=${pluginJson.version}`);
  }

  // Check 5: Required fields present
  const missingFields: string[] = [];
  if (!mp.name) missingFields.push("marketplace:name");
  if (!mp.version) missingFields.push("marketplace:version");
  if (!mp.description) missingFields.push("marketplace:description");
  if (!pluginJson.name) missingFields.push("plugin:name");
  if (!pluginJson.version) missingFields.push("plugin:version");
  if (!pluginJson.description) missingFields.push("plugin:description");

  if (missingFields.length === 0) {
    pass("Required fields present");
  } else {
    fail(`Missing fields: ${missingFields.join(", ")}`);
  }

  console.log();
}

// Check README.md versions match marketplace.json
if (existsSync(readmeFile)) {
  console.log(`${BOLD}README.md${RESET}`);

  const readmeContent = await Bun.file(readmeFile).text();
  let readmeErrors = 0;

  for (const mp of marketplace.plugins) {
    if (!mp.version) continue;

    // Match pattern: [plugin-name]... | X.Y.Z |
    const pattern = new RegExp(`\\[${mp.name}\\][^|]+\\|\\s*([0-9]+\\.[0-9]+\\.[0-9]+)`);
    const match = readmeContent.match(pattern);

    if (match) {
      const readmeVersion = match[1];
      if (readmeVersion !== mp.version) {
        fail(`README version mismatch: ${mp.name} (${readmeVersion} != ${mp.version})`);
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
