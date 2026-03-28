# WorktreeCreate

> Fires when Claude Code creates an isolated worktree -- can replace the default creation logic.

## Basics

- **Fires when:** Claude Code needs to create a git worktree for isolated work (e.g., teammate agents)
- **Can block:** Yes (exit 2 blocks creation; stdout path replaces default behavior)
- **Matcher:** N/A -- no matcher support

### Minimal example

```jsonc
{
  "hooks": {
    "WorktreeCreate": [
      {
        "hooks": [{
          "type": "command",
          "command": "/home/user/.local/bin/worktree-create-hook",
          "timeout": 60
        }]
      }
    ]
  }
}
```

## Input / Output

### Stdin (JSON)

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Requested worktree name |
| `cwd` | `string` | Current working directory (repo root) |

### Stdout / Exit codes

Print the **absolute path** of the created worktree to stdout to override the default worktree location.

| Exit code | Meaning |
|-----------|---------|
| `0` | Worktree created (stdout = path to use) |
| `2` | Block creation (stderr shown to Claude as explanation) |
| Other non-zero | Hook failed -- falls back to default behavior |

## Patterns

### Custom worktree location and setup

Create worktrees inside the repo at `.claude/worktrees/<name>/` instead of the default location, with full post-setup (dependency install, tool configuration, symlinks).

```bash
#!/usr/bin/env bash
set -euo pipefail

input=$(cat)
name=$(printf '%s' "${input}" | jq -r '.name // empty')
repo_root=$(git rev-parse --show-toplevel)
worktree_dir="${repo_root}/.claude/worktrees/${name}"

mkdir -p "$(dirname "${worktree_dir}")"

# Reuse existing worktree (idempotent)
if git worktree list --porcelain | grep -q "^worktree ${worktree_dir}$"; then
  printf '%s' "${worktree_dir}"
  exit 0
fi

git worktree add --detach "${worktree_dir}" 2>&1 >&2

# Post-setup: install dependencies, configure tools
(
  cd "${worktree_dir}"

  # Trust mise environment (if using mise)
  command -v mise > /dev/null && mise trust 2>&1 >&2

  # Install dependencies
  bun install --frozen-lockfile 2>&1 >&2

  # Install git hooks
  command -v lefthook > /dev/null && lefthook install 2>&1 >&2

  # Symlink shared resources (e.g., skills directory)
  [ -d "${repo_root}/.claude/skills" ] && \
    ln -sfn "${repo_root}/.claude/skills" "${worktree_dir}/.claude/skills"
) || true

printf '%s' "${worktree_dir}"
```

### Block worktree creation conditionally

Prevent worktree creation when the repo is in a bad state (e.g., uncommitted changes on main).

```bash
#!/usr/bin/env bash
set -euo pipefail

input=$(cat)

# Block if there are uncommitted changes on the current branch
if ! git diff --quiet HEAD; then
  echo "Cannot create worktree: uncommitted changes on current branch" >&2
  exit 2
fi

# Fall through to default behavior
exit 1
```

## Edge Cases

- **Idempotency is required.** If the worktree already exists, return its path and exit 0. Do not attempt to create it again -- `git worktree add` will fail on a path that is already registered.
- **Stderr goes to Claude.** On exit 2, stderr is shown to Claude as the reason for blocking. On exit 0, stderr is suppressed (use it for logging build output).
- **Stdout must be clean.** Only the worktree path should be on stdout. Route all other output (build logs, install progress) to stderr with `2>&1 >&2`.
- **Post-setup failures should not block.** Wrap setup steps in a subshell with `|| true` so a failed `bun install` does not prevent worktree creation.

## Resources

- [Hooks Reference](https://code.claude.com/docs/en/hooks) — official documentation
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/)

## See Also

- [WorktreeRemove](worktree-remove.md) -- fires when a worktree is being removed
