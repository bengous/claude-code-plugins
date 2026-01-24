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

Based on the analysis, recommend a version bump using AskUserQuestion:

**Recommend MAJOR when:**
- Commands were removed or renamed
- Breaking changes to command arguments/behavior
- Major architectural rewrites

**Recommend MINOR when:**
- New commands added
- New skills or agents added
- Significant new functionality

**Recommend PATCH when:**
- Bug fixes
- Documentation updates
- Small improvements or refactoring
- No new user-facing features

Present the options with your recommendation first (marked as recommended) and explain why.

### 5. Bump Version

Calculate the new version based on user selection:
- MAJOR: `X.0.0` (reset minor and patch)
- MINOR: `x.Y.0` (reset patch)
- PATCH: `x.y.Z`

Update the version in plugin.json:
```bash
jq --arg v "<new-version>" '.version = $v' <plugin-name>/.claude-plugin/plugin.json > tmp.json && mv tmp.json <plugin-name>/.claude-plugin/plugin.json
```

### 6. Stage and Commit

```bash
git add <plugin-name>/
git status
```

Create commit with format:
```
<type>(<plugin-name>): <description>

<body if needed>
```

Where `<type>` is:
- `feat` for MINOR bumps (new features)
- `fix` for PATCH bumps (fixes)
- `breaking` or `feat!` for MAJOR bumps

Example:
```bash
git commit -m "feat(git-tools): add interactive rebase command

- New /rebase command with visual plan
- Support for commit squashing and reordering
- Bumps version to 1.12.0"
```

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
