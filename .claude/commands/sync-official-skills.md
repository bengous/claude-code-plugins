---
allowed-tools: Bash(*/sync-anthropic-skills *), AskUserQuestion
description: Sync anthropic-agent-skills marketplace with upstream and vendor skills to claude-meta-tools
---

# Sync Official Anthropic Skills

Check sync status with official `anthropics/skills` repo and optionally update.
Also vendors official skills (like skill-creator) to claude-meta-tools plugin.

## Step 1: Check Status

Run the sync script in check mode:
```bash
~/projects/claude-plugins/.claude/scripts/sync-anthropic-skills --check
```

**Exit codes:**
- `0` = Up to date
- `1` = Behind upstream (updates available)
- `2` = Error (repo missing, diverged, dirty tree)

## Step 2: Handle Status

**If up to date (exit 0):** Report success and stop.

**If error (exit 2):** Report the error message and stop.

**If behind (exit 1):** Continue to step 3.

## Step 3: Confirm Update

Use AskUserQuestion:
- "Pull updates and sync" - proceed to step 4
- "Skip" - stop

## Step 4: Pull Updates

```bash
~/projects/claude-plugins/.claude/scripts/sync-anthropic-skills --pull
```

This will:
1. Fast-forward merge the marketplace repo
2. Vendor official skills to claude-meta-tools (e.g., skill-creator)

Report success or failure.
