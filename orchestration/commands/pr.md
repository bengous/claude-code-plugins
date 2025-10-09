---
description: Create or surface a PR via gh (idempotent)
argument-hint: [--head <branch>] [--base <branch>] [--title <text>] [--body <text>]
---

Create a GitHub pull request using `gh pr create`. This command is idempotent - if a PR already exists, it returns the existing PR URL.

**Usage:**

```bash
/pr
/pr --base dev
/pr --head feature-branch --base dev --title "Add feature" --body "Description here"
```

**Arguments:**

- `--head <branch>`: Source branch (default: current branch)
- `--base <branch>`: Target branch (default: dev)
- `--title <text>`: PR title (default: auto-generated from commits)
- `--body <text>`: PR description (default: auto-generated from commits)

**Execution:**

1. Parse arguments from $ARGUMENTS
2. Determine head branch (use current if not specified)
3. Determine base branch (use dev if not specified)
4. Check if PR already exists:
   ```bash
   gh pr list --head <head> --base <base> --json number,url --jq '.[0].url'
   ```
5. If PR exists, return URL and exit
6. If no PR exists, create one:
   ```bash
   gh pr create --head <head> --base <base> [--title "..."] [--body "..."] --fill
   ```
7. Return the created PR URL

**Example output:**

```
PR already exists: https://github.com/user/repo/pull/123
```

or

```
PR created: https://github.com/user/repo/pull/124
```

**Important:**

- Always check for existing PR first (idempotency)
- Use `--fill` to auto-populate title/body from commits if not explicitly provided
- Return only the PR URL in the output (concise, machine-readable)
