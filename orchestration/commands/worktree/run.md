---
description: Run pnpm script in worktree directory
argument-hint: <name> <script> [...args]
allowed-tools:
  - Bash(*:*)
model: claude-sonnet-4-5
---

Execute pnpm scripts from package.json within a worktree context. Convenience wrapper around `pnpm run` with automatic worktree path resolution.

**Common patterns:**

```bash
# Run test suite
/worktree:run my-feature test

# Run tests with coverage
/worktree:run my-feature test --coverage

# Run build
/worktree:run api-work build

# Run dev server
/worktree:run my-feature dev

# Run linter
/worktree:run experiment lint --fix

# Run custom script with args
/worktree:run my-feature e2e --headed
```

**Syntax:**

```
/worktree:run <name> <script> [args...]
```

All arguments after `<script>` are passed to the pnpm script.

**Behavior:**

- Changes directory to worktree path
- Executes `pnpm run <script> [args...]`
- Returns script output and exit code
- Respects package.json scripts from worktree

**Common scripts:**

- `test` - Run test suite
- `build` - Build project
- `dev` - Start development server
- `lint` - Run linter
- `type-check` - Run TypeScript type checker
- `e2e` - Run end-to-end tests

**Use cases:**

1. **Testing**: Run tests in isolated worktree
2. **Building**: Verify build succeeds
3. **Development**: Start dev server in worktree
4. **Quality checks**: Run lint, type-check, validation

**Related commands:**

- `/worktree:exec` - Execute arbitrary commands
- `/worktree:bootstrap` - Install dependencies first
- `/worktree:status` - Check worktree state

**Plugin location:** !`realpath ~/.claude/plugins/marketplaces/bengolea-plugins/orchestration 2>/dev/null || echo "/home/b3ngous/projects/claude-plugins/orchestration"`

**Your task:**

Execute the worktree management script:

```bash
<plugin-location-from-above>/scripts/worktree/worktree run $ARGUMENTS
```

Show the full output to the user.