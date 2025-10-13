---
description: Install dependencies (pnpm install) with lockfile tracking
argument-hint: <name>
allowed-tools:
  - Bash(*:*)
model: claude-sonnet-4-5
---

Install project dependencies in a worktree using `pnpm install` with smart lockfile change detection to avoid unnecessary reinstalls.

**Common patterns:**

```bash
# Install dependencies after creation
/worktree:create my-feature
/worktree:bootstrap my-feature

# Or use --install flag during creation
/worktree:create my-feature --install

# Force reinstall after lockfile changes
/worktree:bootstrap my-feature
```

**Behavior:**

1. Checks if `pnpm-lock.yaml` exists in repo root
2. Computes SHA256 hash of lockfile
3. Compares with stored hash in worktree metadata
4. If unchanged: Skips install (outputs "pnpm-lock.yaml unchanged")
5. If changed: Runs `pnpm install --frozen-lockfile --prefer-offline`
6. Updates metadata with new hash and timestamp

**Command executed:**

```bash
pnpm install --frozen-lockfile --prefer-offline
```

- `--frozen-lockfile`: Fails if lockfile would be modified
- `--prefer-offline`: Uses cached packages when possible

**Benefits:**

- **Fast**: Skips unnecessary reinstalls
- **Safe**: Detects lockfile changes automatically
- **Trackable**: Records bootstrap status in metadata
- **Offline-friendly**: Prefers local cache

**When to use:**

1. After creating new worktree (or use `--install` flag)
2. After pulling lockfile changes from remote
3. When dependencies are missing or outdated

**Related commands:**

- `/worktree:create` - Use `--install` flag to auto-bootstrap
- `/worktree:run` - Run pnpm scripts after bootstrapping
- `/worktree:exec` - Execute commands in worktree

**Plugin location:** !`realpath ~/.claude/plugins/marketplaces/bengolea-plugins/orchestration 2>/dev/null || echo "$HOME/projects/claude-plugins/orchestration"`

**Your task:**

Execute the worktree management script:

```bash
<plugin-location-from-above>/scripts/worktree/worktree bootstrap $ARGUMENTS
```

Show the full output to the user.