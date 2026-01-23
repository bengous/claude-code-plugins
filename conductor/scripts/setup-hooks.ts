#!/usr/bin/env bun
/**
 * T-Plan Hook Installer
 *
 * Registers t-plan SubagentStop hook into ~/.claude/settings.local.json
 * for contract verification.
 *
 * NOTE: PreToolUse hooks (init + coordinator) are now skill-scoped
 * and defined in skills/t-plan/SKILL.md frontmatter.
 *
 * Usage:
 *   bun setup-hooks.ts [--dry-run] [--force] [--remove]
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "fs";
import { homedir } from "os";
import { join, dirname, resolve } from "path";
import { parseArgs } from "util";
import {
  PLUGIN_MARKER,
  isPluginHook,
  removePluginHooks,
  mergeHooks,
  type HooksConfig,
} from "./lib/hooks-utils";

// Parse command line arguments
const { values: flags } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "dry-run": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    remove: { type: "boolean", default: false },
  },
  strict: true,
});

// Configuration
const HOME = homedir();
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || resolve(dirname(Bun.main), "..");
const HOOKS_DIR = join(PLUGIN_ROOT, "hooks");
const SETTINGS_FILE = join(HOME, ".claude", "settings.local.json");
const BACKUP_FILE = join(HOME, ".claude", "settings.local.json.backup");

// Hook definitions
// NOTE: PreToolUse hooks are now skill-scoped in SKILL.md frontmatter
const PLUGIN_HOOKS: HooksConfig = {
  SubagentStop: [
    {
      matcher: "*",
      hooks: [
        {
          type: "command",
          command: `bun "${join(HOOKS_DIR, "subagent-contract.ts")}"`,
          timeout: 30,
          description: `T-plan contract verification ${PLUGIN_MARKER}`,
        },
      ],
    },
  ],
};

// Utility functions
function readJSON(filepath: string): Record<string, unknown> | null {
  try {
    const content = readFileSync(filepath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new Error(`Failed to parse ${filepath}: ${(error as Error).message}`);
  }
}

function writeJSON(filepath: string, data: unknown): void {
  const dir = dirname(filepath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filepath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

// Main logic
function main(): void {
  console.log("Conductor Plugin - Hook Installer\n");

  // Validate hook scripts exist
  const hookScripts = [
    join(HOOKS_DIR, "subagent-contract.ts"),
  ];

  for (const script of hookScripts) {
    if (!existsSync(script)) {
      console.error("Hook script not found:", script);
      console.error("\nThis command must be run from an installed Conductor plugin.");
      process.exit(1);
    }
  }

  console.log("Hook scripts found:");
  hookScripts.forEach((s) => console.log(`  - ${s}`));

  // Read or create settings
  let settings = readJSON(SETTINGS_FILE) as { hooks?: HooksConfig } | null;
  if (!settings) {
    console.log("\nCreating new settings file");
    settings = {};
  } else {
    console.log("\nSettings file found");
  }

  // Initialize hooks object
  settings.hooks = settings.hooks || {};

  if (flags.remove) {
    // Remove plugin hooks
    console.log("\nRemoving plugin hooks...\n");

    let removed = 0;
    for (const event of Object.keys(PLUGIN_HOOKS)) {
      if (settings.hooks[event]) {
        const before = settings.hooks[event].length;
        settings.hooks[event] = removePluginHooks(settings.hooks[event]);
        const after = settings.hooks[event].length;

        if (before > after) {
          console.log(`  - Removed ${before - after} ${event} hook(s)`);
          removed += before - after;
        }

        // Clean up empty arrays
        if (settings.hooks[event].length === 0) {
          delete settings.hooks[event];
        }
      }
    }

    if (removed === 0) {
      console.log("No plugin hooks found");
      process.exit(0);
    }

    console.log(`\nRemoved ${removed} hook(s)`);
  } else {
    // Install plugin hooks
    console.log("\nInstalling hooks...\n");

    // Check if already installed
    let alreadyInstalled = 0;
    for (const [event, matchers] of Object.entries(PLUGIN_HOOKS)) {
      if (settings.hooks[event]) {
        for (const matcher of matchers) {
          const existing = settings.hooks[event].find(
            (m) => m.matcher === matcher.matcher
          );
          if (existing && existing.hooks.some(isPluginHook)) {
            alreadyInstalled++;
          }
        }
      }
    }

    if (alreadyInstalled > 0 && !flags.force) {
      console.log("Plugin hooks already installed");
      console.log("\nUse --force to reinstall");
      process.exit(0);
    }

    // Merge hooks
    for (const [event, matchers] of Object.entries(PLUGIN_HOOKS)) {
      settings.hooks[event] = mergeHooks(settings.hooks[event], matchers);
    }

    console.log("Installed 1 hook from conductor plugin:");
    console.log("  - SubagentStop:* -> subagent-contract.ts");
    console.log("\nNote: PreToolUse hooks are now skill-scoped in SKILL.md");
  }

  // Dry run check
  if (flags["dry-run"]) {
    console.log("\nDry run - no changes made");
    console.log("\nWould write to:", SETTINGS_FILE);
    console.log(JSON.stringify(settings, null, 2));
    process.exit(0);
  }

  // Backup existing settings
  if (existsSync(SETTINGS_FILE)) {
    try {
      copyFileSync(SETTINGS_FILE, BACKUP_FILE);
      console.log("\nBackup saved:", BACKUP_FILE);
    } catch (error) {
      console.warn("Warning: Could not create backup:", (error as Error).message);
    }
  }

  // Write settings
  try {
    writeJSON(SETTINGS_FILE, settings);
    console.log("Settings updated:", SETTINGS_FILE);
  } catch (error) {
    console.error("\nFailed to write settings:", (error as Error).message);
    process.exit(1);
  }

  // Success message
  console.log("\nSetup complete!");
  console.log("\nNote: Restart Claude Code if hooks don't work immediately");
}

// Run
try {
  main();
} catch (error) {
  console.error("\nError:", (error as Error).message);
  process.exit(1);
}
