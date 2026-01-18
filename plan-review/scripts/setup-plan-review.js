#!/usr/bin/env node
/**
 * setup-plan-review.js
 *
 * Installs plan review hooks into .claude/settings.local.json
 * Follows the pattern from orchestration/scripts/setup-hooks.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Parse command line arguments
const args = process.argv.slice(2);
const flags = {
  dryRun: args.includes('--dry-run'),
  force: args.includes('--force'),
  remove: args.includes('--remove'),
};

// Configuration
const HOME = os.homedir();
const SCRIPT_DIR = __dirname;
const PLUGIN_ROOT = path.dirname(SCRIPT_DIR);
const SETTINGS_FILE = '.claude/settings.local.json';
const BACKUP_FILE = '.claude/settings.local.json.backup';

// Find hook script path (works whether plugin is installed or in dev)
function findHookScript() {
  // Check if we're in the installed location
  const installedPath = path.join(HOME, '.claude', 'plugins', 'marketplaces');
  const candidates = [
    path.join(PLUGIN_ROOT, 'hooks', 'preuse-exitplanmode.py'),
    // Search installed plugins
    ...fs.readdirSync(installedPath, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => path.join(installedPath, d.name, 'plan-review', 'hooks', 'preuse-exitplanmode.py'))
      .filter(p => fs.existsSync(p))
  ].filter(p => fs.existsSync(p));

  return candidates[0] || path.join(PLUGIN_ROOT, 'hooks', 'preuse-exitplanmode.py');
}

const HOOK_SCRIPT_PATH = findHookScript();

// Hook definitions
const PLUGIN_HOOKS = {
  PreToolUse: [
    {
      matcher: 'ExitPlanMode',
      hooks: [
        {
          type: 'command',
          command: HOOK_SCRIPT_PATH,
          timeout: 10,
          description: 'Requires plan review before execution (from plugin)',
        },
      ],
    },
  ],
};

// Utility functions
function fileExists(filepath) {
  try {
    fs.accessSync(filepath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function readJSON(filepath) {
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw new Error(`Failed to parse ${filepath}: ${error.message}`);
  }
}

function writeJSON(filepath, data) {
  const dir = path.dirname(filepath);
  if (!fileExists(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Atomic write: write to temp file then rename
  const tmpFile = filepath + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpFile, filepath);
}

function isPluginHook(hook) {
  return hook.description && hook.description.includes('(from plugin)');
}

function removePluginHooks(hooks) {
  if (!Array.isArray(hooks)) return hooks;
  return hooks
    .map(matcher => ({
      ...matcher,
      hooks: matcher.hooks.filter(h => !isPluginHook(h)),
    }))
    .filter(matcher => matcher.hooks.length > 0);
}

function mergeHooks(existing, plugin) {
  if (!Array.isArray(existing)) {
    return plugin;
  }

  // Remove any existing plugin hooks first
  const cleaned = removePluginHooks(existing);

  // Merge plugin hooks
  const result = [...cleaned];

  for (const pluginMatcher of plugin) {
    const existingMatcher = result.find(m => m.matcher === pluginMatcher.matcher);

    if (existingMatcher) {
      // Merge hooks for this matcher
      existingMatcher.hooks = [...existingMatcher.hooks, ...pluginMatcher.hooks];
    } else {
      // Add new matcher
      result.push(pluginMatcher);
    }
  }

  return result;
}

// Main logic
function main() {
  console.log('Plan Review Plugin - Hook Installer\n');

  // Check hook script exists
  if (!fileExists(HOOK_SCRIPT_PATH)) {
    console.error('Hook script not found:', HOOK_SCRIPT_PATH);
    console.error('\nEnsure the plugin is properly installed.');
    process.exit(1);
  }

  console.log('Hook script:', HOOK_SCRIPT_PATH);

  // Read or create settings
  let settings = readJSON(SETTINGS_FILE);
  if (!settings) {
    console.log('Creating new settings file');
    settings = {};
  } else {
    console.log('Settings file found');
  }

  // Initialize hooks object
  settings.hooks = settings.hooks || {};

  if (flags.remove) {
    // Remove plugin hooks
    console.log('\nRemoving plugin hooks...\n');

    let removed = 0;
    for (const event of Object.keys(PLUGIN_HOOKS)) {
      if (settings.hooks[event]) {
        const before = JSON.stringify(settings.hooks[event]);
        settings.hooks[event] = removePluginHooks(settings.hooks[event]);
        const after = JSON.stringify(settings.hooks[event]);

        if (before !== after) {
          console.log(`   - Removed ${event} hook(s)`);
          removed++;
        }

        // Clean up empty arrays
        if (settings.hooks[event].length === 0) {
          delete settings.hooks[event];
        }
      }
    }

    if (removed === 0) {
      console.log('No plugin hooks found');
      process.exit(0);
    }

    console.log(`\nRemoved ${removed} hook(s)`);

  } else {
    // Install plugin hooks
    console.log('\nInstalling hooks...\n');

    // Check if already installed
    let alreadyInstalled = false;
    for (const [event, hooks] of Object.entries(PLUGIN_HOOKS)) {
      if (settings.hooks[event]) {
        for (const matcher of hooks) {
          const existing = settings.hooks[event].find(m => m.matcher === matcher.matcher);
          if (existing && existing.hooks.some(isPluginHook)) {
            alreadyInstalled = true;
          }
        }
      }
    }

    if (alreadyInstalled && !flags.force) {
      console.log('Plugin hooks already installed');
      console.log('\nUse --force to reinstall');
      process.exit(0);
    }

    // Merge hooks
    for (const [event, hooks] of Object.entries(PLUGIN_HOOKS)) {
      settings.hooks[event] = mergeHooks(settings.hooks[event], hooks);
    }

    console.log('Installed 1 hook from plan-review plugin');
    console.log('   - PreToolUse:ExitPlanMode -> plan review gate');
  }

  // Dry run check
  if (flags.dryRun) {
    console.log('\nDry run - no changes made');
    console.log('\nWould write to:', SETTINGS_FILE);
    console.log(JSON.stringify(settings, null, 2));
    process.exit(0);
  }

  // Backup existing settings
  if (fileExists(SETTINGS_FILE)) {
    try {
      fs.copyFileSync(SETTINGS_FILE, BACKUP_FILE);
      console.log('\nBackup saved:', BACKUP_FILE);
    } catch (error) {
      console.warn('Warning: Could not create backup:', error.message);
    }
  }

  // Write settings
  try {
    writeJSON(SETTINGS_FILE, settings);
    console.log('Settings updated:', SETTINGS_FILE);
  } catch (error) {
    console.error('\nFailed to write settings:', error.message);
    process.exit(1);
  }

  // Success message
  console.log('\nSetup complete!');
  console.log('\nHow it works:');
  console.log('   1. Enter plan mode and create a plan');
  console.log('   2. When you try to exit, the hook will block');
  console.log('   3. Spawn architect and simplifier review agents');
  console.log('   4. Update plan with "## Plan Review Status: APPROVED"');
  console.log('   5. Exit plan mode succeeds');
  console.log('\nBypass options:');
  console.log('   - Add <!-- QUICK --> to plan for trivial changes');
  console.log('   - Plans under 50 lines auto-bypass');
}

// Run
try {
  main();
} catch (error) {
  console.error('\nError:', error.message);
  process.exit(1);
}
