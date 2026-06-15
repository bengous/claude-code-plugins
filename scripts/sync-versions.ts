#!/usr/bin/env bun
/**
 * Version sync script (pre-commit auto-fix)
 *
 * plugin.json is the single source of truth for a plugin's version. This script
 * propagates each plugin's version into the two derived locations:
 *   (a) the matching entry in .claude-plugin/marketplace.json
 *   (b) the matching row in README.md
 *
 * Modified files are written atomically and re-staged so the commit stays in
 * sync. validate-marketplace runs afterwards as a safety net.
 */

import { $ } from "bun";
import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import {
  extractVersionFromReadme,
  setVersionInReadme,
  type PluginEntry,
} from "./lib/marketplace-validation";

const repoRootResult = await $`git rev-parse --show-toplevel`.nothrow().quiet();
if (repoRootResult.exitCode !== 0) {
  console.error("Error: Not in a git repository");
  process.exit(2);
}
const repoRoot = repoRootResult.text().trim();

const marketplaceFile = join(repoRoot, ".claude-plugin/marketplace.json");
const readmeFile = join(repoRoot, "README.md");

if (!existsSync(marketplaceFile)) {
  console.error(`Error: ${marketplaceFile} not found`);
  process.exit(2);
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

const readmeContent = existsSync(readmeFile)
  ? await Bun.file(readmeFile).text()
  : "";

let newReadme = readmeContent;
let marketplaceChanged = false;
const changes: string[] = [];

for (const mp of marketplace.plugins) {
  // plugin.json is the source of truth. If it's missing or invalid, leave the
  // derived files alone and let validate-marketplace report the real problem.
  const pluginJsonPath = join(repoRoot, mp.source, ".claude-plugin/plugin.json");
  if (!existsSync(pluginJsonPath)) continue;

  let pluginVersion: string | undefined;
  try {
    pluginVersion = (await Bun.file(pluginJsonPath).json()).version;
  } catch {
    continue;
  }
  if (!pluginVersion) continue;

  if (mp.version !== pluginVersion) {
    changes.push(`${mp.name}: marketplace.json ${mp.version} -> ${pluginVersion}`);
    mp.version = pluginVersion;
    marketplaceChanged = true;
  }

  const readmeVersion = extractVersionFromReadme(newReadme, mp.name);
  if (readmeVersion && readmeVersion !== pluginVersion) {
    changes.push(`${mp.name}: README.md ${readmeVersion} -> ${pluginVersion}`);
    newReadme = setVersionInReadme(newReadme, mp.name, pluginVersion);
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, content);
  await rename(tmp, path);
}

const toStage: string[] = [];
if (marketplaceChanged) {
  await atomicWrite(marketplaceFile, JSON.stringify(marketplace, null, 2) + "\n");
  toStage.push(marketplaceFile);
}
if (newReadme !== readmeContent) {
  await atomicWrite(readmeFile, newReadme);
  toStage.push(readmeFile);
}

if (toStage.length > 0) {
  await $`git add ${toStage}`.quiet();
  console.log("Synced versions from plugin.json:");
  for (const c of changes) console.log(`  ${c}`);
} else {
  console.log("Versions already in sync.");
}
