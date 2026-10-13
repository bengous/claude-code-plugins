---
description: Commit plugin changes with automatic version bump (semver)
argument-hint: [plugin-name]
allowed-tools:
  - Bash(git:*)
  - Bash(jq:*)
  - Read
  - Glob
  - Grep
  - AskUserQuestion
  - Edit
---

# Commit Plugin

Commit changes to a plugin with proper semantic versioning.

## Workflow

### 1. Identify the Plugin

If `$ARGUMENTS` is provided, use that as the plugin name. Otherwise, detect from staged/unstaged changes:

```bash
git status --porcelain | grep -E '^\s*[MADR?]+\s+[^/]+/' | sed 's|.*\s\+\([^/]*\)/.*|\1|' | sort -u
```

If multiple plugins have changes, ask the user which one to commit.

Validate the plugin exists:
```bash
test -f "<plugin-name>/.claude-plugin/plugin.json"
```

### 2. Analyze Changes

Get the diff for this plugin:
```bash
git diff HEAD -- <plugin-name>/
git diff --cached -- <plugin-name>/
git status --porcelain -- <plugin-name>/
```

Categorize the changes:

| Change Type | Version Impact | Examples |
|-------------|----------------|----------|
| **Breaking** | MAJOR | Removed commands, renamed commands, changed command behavior incompatibly |
| **New features** | MINOR | New commands, new skills, new agents, new significant functionality |
| **Fixes/improvements** | PATCH | Bug fixes, documentation, refactoring, small tweaks |

### 3. Get Current Version

```bash
jq -r '.version' <plugin-name>/.claude-plugin/plugin.json
```

### 4. Recommend Version Bump

Recommend the bump the table in step 2 gives, using AskUserQuestion: present the options with your recommendation first (marked as recommended) and explain why.

### 5. Bump Version

Calculate the new version based on user selection:
- MAJOR: `X.0.0` (reset minor and patch)
- MINOR: `x.Y.0` (reset patch)
- PATCH: `x.y.Z`

Update the version in plugin.json:
```bash
jq --arg v "<new-version>" '.version = $v' <plugin-name>/.claude-plugin/plugin.json > tmp.json && mv tmp.json <plugin-name>/.claude-plugin/plugin.json
```

> **Note:** `plugin.json` is the single source of truth for the version and for the description. The `sync-versions` pre-commit hook propagates both to the plugin's existing entry in `.claude-plugin/marketplace.json` and its row in the `README.md` table, and re-stages them automatically, so do not edit them by hand. A new plugin has neither yet: add both by hand, since no check catches their absence. `validate-marketplace` then runs as a safety net.

### 6. Stage and Commit

Commit the plugin's changes first, under their own type (`feat(<plugin-name>): ...`, `fix(<plugin-name>): ...`), if they are not committed yet. The bump is a commit of its own:

```bash
git add <plugin-name>/.claude-plugin/plugin.json
git commit -m "chore(<plugin-name>): <new-version>, <one-line summary of the release>"
```

When `<plugin-name>/CHANGELOG.md` exists, add a `## <new-version> - <YYYY-MM-DD>` section to it, written for the plugin's users from the commits since the last section, and stage it with `plugin.json` so both land in that one commit: `validate-marketplace` refuses a version its changelog has no section for, and names the `git log` range to read.

### 7. Report Result

Show:
- Plugin name
- Version change (old → new)
- Files committed
- Commit hash

## Edge Cases

**New plugin (no existing version):**
- Set initial version to `1.0.0`
- Skip version bump question
- Use `feat(<plugin>): initial release` as commit message

**No changes detected:**
- Inform user there's nothing to commit for this plugin

**Unstaged changes only:**
- Stage them before committing (confirm with user if many files)
