#!/usr/bin/env bun
/**
 * Version and description sync script (pre-commit auto-fix)
 *
 * plugin.json is the single source of truth for a plugin's version and for its
 * description. This script propagates both into the two derived locations:
 *   (a) the matching entry in .claude-plugin/marketplace.json
 *   (b) the matching row in README.md
 *
 * Modified files are written atomically and re-staged so the commit stays in
 * sync. validate-marketplace runs afterwards as a safety net.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { GitError, git, gitRead, writeAtomic } from "../tools/platform/node.ts";
import {
  extractDescriptionFromReadme,
  extractVersionFromReadme,
  setDescriptionInReadme,
  setVersionInReadme,
  validateDescriptionCell,
  type PluginEntry,
  type PluginJson,
} from "./lib/marketplace-validation";

const SHOW_TOPLEVEL = ["rev-parse", "--show-toplevel"];

const repoRootResult = await git(SHOW_TOPLEVEL);

if (repoRootResult.kind !== "exited" || repoRootResult.code !== 0) {
  console.error("Error: Not in a git repository");
  process.exit(2);
}

if (repoRootResult.outputLost === true) throw new GitError(SHOW_TOPLEVEL, repoRootResult);

const repoRoot = repoRootResult.stdout.trim();

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

const readmeContent = existsSync(readmeFile) ? await Bun.file(readmeFile).text() : "";

let newReadme = readmeContent;

let marketplaceChanged = false;

const changes: string[] = [];

const refusals: string[] = [];

for (const mp of marketplace.plugins) {
  // plugin.json is the source of truth. If it's missing or invalid, leave the
  // derived files alone and let validate-marketplace report the real problem.
  const pluginJsonPath = join(repoRoot, mp.source, ".claude-plugin/plugin.json");

  if (!existsSync(pluginJsonPath)) continue;

  let pluginJson: PluginJson;

  try {
    pluginJson = await Bun.file(pluginJsonPath).json();
  } catch {
    continue;
  }

  const { version: pluginVersion, description: pluginDescription } = pluginJson;

  if (pluginVersion) {
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

  if (!pluginDescription) continue;

  const cell = validateDescriptionCell(mp.name, pluginDescription);

  if (!cell.passed) {
    refusals.push(cell.message);
    continue;
  }

  if (mp.description !== pluginDescription) {
    changes.push(`${mp.name}: marketplace.json description`);
    mp.description = pluginDescription;
    marketplaceChanged = true;
  }

  const readmeDescription = extractDescriptionFromReadme(newReadme, mp.name);

  if (readmeDescription !== null && readmeDescription !== pluginDescription) {
    changes.push(`${mp.name}: README.md description`);
    newReadme = setDescriptionInReadme(newReadme, mp.name, pluginDescription);
  }
}

if (refusals.length > 0) {
  console.error("Refusing to sync: a description no README table cell can carry.");

  for (const refusal of refusals) console.error(`  ${refusal}`);

  process.exit(1);
}

const toStage: string[] = [];

if (marketplaceChanged) {
  await writeAtomic(marketplaceFile, JSON.stringify(marketplace, null, 2) + "\n", { mkdir: true });
  toStage.push(marketplaceFile);
}

if (newReadme !== readmeContent) {
  await writeAtomic(readmeFile, newReadme, { mkdir: true });
  toStage.push(readmeFile);
}

if (toStage.length > 0) {
  await gitRead(["add", ...toStage]);
  console.log("Synced from plugin.json:");

  for (const c of changes) console.log(`  ${c}`);
} else {
  console.log("Versions and descriptions already in sync.");
}
