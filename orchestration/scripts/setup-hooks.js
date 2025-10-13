#!/usr/bin/env node
/**
 * setup-hooks.js
 *
 * Installs orchestration plugin hooks into .claude/settings.local.json
 * Workaround for Claude Code v2.0.13 not auto-loading plugin hooks.
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
const PLUGIN_PATH = path.join(HOME, '.claude', 'plugins', 'marketplaces', 'bengolea-plugins', 'orchestration');
const SETTINGS_FILE = '.claude/settings.local.json';
const BACKUP_FILE = '.claude/settings.local.json.backup';

// Hook definitions
// Note: Using ~ expansion which works in both shell contexts and Claude Code
const PLUGIN_HOOKS = {
  PreToolUse: [
    {
      matcher: 'Bash',
      hooks: [
        {
          type: 'command',
          command: '~/.claude/plugins/marketplaces/bengolea-plugins/orchestration/hooks/worktree-guard.py',
          timeout: 5,
          description: 'Blocks raw git worktree commands (from plugin)',
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
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2) + '\n', 'utf8');
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
  console.log('🔧 Claude Orchestration Plugin - Hook Installer\n');

  // Validate plugin is installed
  if (!fileExists(PLUGIN_PATH)) {
    console.error('❌ Plugin not installed at:', PLUGIN_PATH);
    console.error('\n💡 Install with: /plugin');
    process.exit(1);
  }

  console.log('✓ Plugin found at:', PLUGIN_PATH);

  // Read or create settings
  let settings = readJSON(SETTINGS_FILE);
  if (!settings) {
    console.log('✓ Creating new settings file');
    settings = {};
  } else {
    console.log('✓ Settings file found');
  }

  // Initialize hooks object
  settings.hooks = settings.hooks || {};

  if (flags.remove) {
    // Remove plugin hooks
    console.log('\n🗑️  Removing plugin hooks...\n');

    let removed = 0;
    for (const event of Object.keys(PLUGIN_HOOKS)) {
      if (settings.hooks[event]) {
        const before = settings.hooks[event].length;
        settings.hooks[event] = removePluginHooks(settings.hooks[event]);
        const after = settings.hooks[event].length;

        if (before > after) {
          console.log(`   - Removed ${before - after} ${event} hook(s)`);
          removed += before - after;
        }

        // Clean up empty arrays
        if (settings.hooks[event].length === 0) {
          delete settings.hooks[event];
        }
      }
    }

    if (removed === 0) {
      console.log('ℹ️  No plugin hooks found');
      process.exit(0);
    }

    console.log(`\n✅ Removed ${removed} hook(s)`);

  } else {
    // Install plugin hooks
    console.log('\n📦 Installing hooks...\n');

    // Check if already installed
    let alreadyInstalled = 0;
    for (const [event, hooks] of Object.entries(PLUGIN_HOOKS)) {
      if (settings.hooks[event]) {
        for (const matcher of hooks) {
          const existing = settings.hooks[event].find(m => m.matcher === matcher.matcher);
          if (existing && existing.hooks.some(isPluginHook)) {
            alreadyInstalled++;
          }
        }
      }
    }

    if (alreadyInstalled > 0 && !flags.force) {
      console.log('ℹ️  Plugin hooks already installed');
      console.log('\n💡 Use --force to reinstall');
      process.exit(0);
    }

    // Merge hooks
    for (const [event, hooks] of Object.entries(PLUGIN_HOOKS)) {
      settings.hooks[event] = mergeHooks(settings.hooks[event], hooks);
    }

    console.log('✅ Installed 1 hook from claude-orchestration plugin');
    console.log('   - PreToolUse:Bash → worktree-guard.py');
  }

  // Dry run check
  if (flags.dryRun) {
    console.log('\n🔍 Dry run - no changes made');
    console.log('\n📄 Would write to:', SETTINGS_FILE);
    console.log(JSON.stringify(settings, null, 2));
    process.exit(0);
  }

  // Backup existing settings
  if (fileExists(SETTINGS_FILE)) {
    try {
      fs.copyFileSync(SETTINGS_FILE, BACKUP_FILE);
      console.log('\n📝 Backup saved:', BACKUP_FILE);
    } catch (error) {
      console.warn('⚠️  Warning: Could not create backup:', error.message);
    }
  }

  // Write settings
  try {
    writeJSON(SETTINGS_FILE, settings);
    console.log('✅ Settings updated:', SETTINGS_FILE);
  } catch (error) {
    console.error('\n❌ Failed to write settings:', error.message);
    process.exit(1);
  }

  // Success message
  console.log('\n✨ Setup complete!');
  console.log('\n🧪 Test hooks:');
  console.log('   git worktree add /tmp/test  # Should be blocked');
  console.log('\n💡 Note: Restart Claude Code if hooks don\'t work immediately');
}

// Run
try {
  main();
} catch (error) {
  console.error('\n❌ Error:', error.message);
  process.exit(1);
}
