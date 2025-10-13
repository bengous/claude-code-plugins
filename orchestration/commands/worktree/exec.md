---
description: Execute arbitrary command in worktree directory
argument-hint: <name> -- <command>
allowed-tools:
  - Bash(*:*)
model: claude-sonnet-4-5
---

Execute arbitrary shell commands within a worktree's directory context. Useful for running tests, linters, custom scripts, or any command-line tools.

**Important:** Requires `--` separator between worktree name and command.

**Common patterns:**

```bash
# Run tests in worktree
/worktree:exec my-feature -- npm test

# Run linter with auto-fix
/worktree:exec api-work -- pnpm lint --fix

# Run specific test file
/worktree:exec my-feature -- pnpm test src/components/Button.test.tsx

# Check git status in worktree
/worktree:exec experiment -- git status

# Run custom script
/worktree:exec my-feature -- bash scripts/validate.sh
```

**Syntax:**

```
/worktree:exec <name> -- <command> [args...]
```

The `--` separator is **required** to distinguish worktree name from command.

**Behavior:**

- Changes directory to worktree path
- Executes command in that context
- Returns command output and exit code
- Environment variables are preserved

**Use cases:**

1. **Testing**: Run test suites in isolated worktree
2. **Linting**: Run code quality checks
3. **Custom scripts**: Execute project-specific automation
4. **Git commands**: Inspect or modify worktree git state
5. **Build commands**: Run builds in specific worktree

**Related commands:**

- `/worktree:run` - Run pnpm scripts specifically
- `/worktree:bootstrap` - Install dependencies
- `/worktree:status` - Check worktree git status

**Plugin location:** !`realpath ~/.claude/plugins/marketplaces/bengolea-plugins/orchestration`

**Your task:**

Execute the worktree management script:

```bash
<plugin-location-from-above>/scripts/worktree/worktree exec $ARGUMENTS
```

Show the full output to the user.