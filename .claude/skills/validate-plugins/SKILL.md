---
name: validate-plugins
description: Validate plugin structure, versions, and marketplace sync. Use when running CI checks, gating PRs, verifying marketplace.json sync, or auditing plugin directories for version consistency and required fields.
---

# Plugin Validation Skill

Validate plugins in this marketplace repository. Returns structured results suitable for CI gating.

## What You Validate

1. **Marketplace sync**: `marketplace.json` matches each plugin's `.claude-plugin/plugin.json`
2. **Version consistency**: Versions match across marketplace.json, plugin.json, and README.md
3. **Required fields**: name, version, description present in both registries
4. **Structure**: Only `plugin.json` exists in `.claude-plugin/` directories
5. **PR-specific** (when applicable): Focus on changed plugins only

## Execution Steps

### Step 1: Determine Scope

Check if this is a PR context (changed files) or full validation:

```bash
# Try to get changed files (works in PR/branch context)
changed=$(git diff --name-only origin/main...HEAD 2>/dev/null || echo "")
```

If `changed` contains plugin paths, focus validation on those plugins only.
If empty or error, validate all plugins.

### Step 2: Run Existing Validation

Execute the marketplace validation script:

```bash
bun run ./scripts/validate-marketplace.ts
```

Capture both exit code and output.

### Step 3: Check Plugin Structure (additional checks)

For each plugin directory, verify:

```bash
# Only plugin.json should exist in .claude-plugin/
for dir in */.claude-plugin/; do
  count=$(ls -1 "$dir" 2>/dev/null | wc -l)
  if [ "$count" -gt 1 ]; then
    echo "ERROR: Extra files in $dir (only plugin.json allowed)"
  fi
done
```

### Step 4: Check for Hardcoded Paths

```bash
# Scan for hardcoded absolute paths (common mistake)
grep -r --include="*.sh" --include="*.ts" -E "(/home/|/Users/)[a-zA-Z]+" . \
  --exclude-dir=node_modules --exclude-dir=.git || true
```

Report any matches as warnings.

### Step 5: Return Result

Output a summary in this format:

```
## Validation Result

**Status**: PASS | FAIL
**Scope**: all | [list of changed plugins]

### Checks
- [ ] Marketplace sync
- [ ] Version consistency
- [ ] Required fields
- [ ] Structure (single plugin.json)
- [ ] No hardcoded paths

### Errors (if any)
[List specific failures]
```

## CI Usage

Run in GitHub Actions:

```yaml
- name: Validate plugins
  run: |
    claude -p "/validate-plugins" \
      --allowedTools "Bash(bun:*),Bash(git:*),Bash(grep:*),Bash(ls:*),Read,Grep" \
      --output-format json \
      --max-turns 10
```

For programmatic integration, use the `_shared/claude-cli` spawn function with the same options.
