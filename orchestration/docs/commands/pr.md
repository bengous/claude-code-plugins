# Pull Request Commands

Reference for PR automation and workflow management.

## Overview

PR commands provide idempotent pull request creation and management, integrated with the orchestration system.

## Command List

1. [/pr](#pr) - Alias to /pr:create
2. [/pr:create](#prcreate) - Create or surface PR (idempotent)

---

## /pr

**Description:** Alias for `/pr:create`. Quick PR creation from current branch.

**Usage:**
```bash
/pr [options]
```

See [/pr:create](#prcreate) for full documentation.

**Example:**
```bash
# Create PR from current branch to dev
/pr
```

---

## /pr:create

**Description:** Create a GitHub pull request using `gh pr create`. Idempotent - returns existing PR if one already exists.

**Usage:**
```bash
/pr:create [options]
```

**Options:**
- `--head <branch>` - Source branch (default: current branch)
- `--base <branch>` - Target branch (default: `dev`)
- `--title <text>` - PR title (default: auto-generated from commits)
- `--body <text>` - PR description (default: auto-generated from commits)
- `--draft` - Create as draft PR
- `--no-fill` - Don't auto-fill from commits

**Default Behavior:**
- Source: Current branch
- Target: `dev` branch
- Title: Auto-generated from commits
- Body: Auto-generated from commits
- Uses `--fill` flag to populate from git history

## Idempotency

The command checks for existing PRs before creating:

```bash
# First call
/pr:create --head feature-x --base dev
# → Creates PR #127

# Second call (same branches)
/pr:create --head feature-x --base dev
# → Returns existing PR #127 (no duplicate)
```

**Check Logic:**
```bash
gh pr list --head <head> --base <base> --json number,url
```

If a PR exists, returns the URL immediately without creating a new one.

## Examples

### Basic Usage

```bash
# From current branch to dev
/pr:create

# Equivalent to:
git branch --show-current  # Get current branch
/pr:create --head <current> --base dev
```

### Specify Branches

```bash
# From feature branch to dev
/pr:create --head feature-auth --base dev

# From worktree branch to feature base
/pr:create --head worktree/42-auth-core --base feat/auth-system
```

### Custom Title and Body

```bash
# Custom PR metadata
/pr:create --head feature-x --base dev \
           --title "Add user authentication" \
           --body "Implements JWT-based auth with OAuth support"
```

### Draft PR

```bash
# Create draft for early feedback
/pr:create --draft

# Or with specific branches
/pr:create --head feature-x --base dev --draft
```

### Multiple Base Branches

```bash
# PR to staging
/pr:create --base staging

# PR to release branch
/pr:create --base release/v2.0

# PR to custom base (COMPLEX mode)
/pr:create --head feat/auth-step1 --base feat/auth-system
```

## Integration with Orchestration

### SIMPLE Path

```bash
/orc:start "Fix typo"

# Internally calls:
/pr:create --base dev
```

**Result:**
```
PR created: #127
  Head: fix/typo-in-login
  Base: dev
  URL: https://github.com/user/repo/pull/127
```

### MEDIUM Path

```bash
/orc:start "Add profile page"

# If using worktree:
# Internally calls:
/pr:create --head worktree/profile-page --base dev
```

**Result:**
```
PR created: #128
  Head: worktree/profile-page
  Base: dev
  URL: https://github.com/user/repo/pull/128
```

### COMPLEX Path (Sub-PRs)

```bash
/orc:start "Refactor auth system" --confirm

# Step 1: Core module
# Internally calls:
/pr:create --head feat/auth-refactor-core --base feat/auth-refactor

# Step 2: OAuth
# Internally calls:
/pr:create --head feat/auth-refactor-oauth --base feat/auth-refactor

# Step 3: Tests
# Internally calls:
/pr:create --head feat/auth-refactor-tests --base feat/auth-refactor

# Final PR
# Internally calls:
/pr:create --head feat/auth-refactor --base dev
```

**Result:**
```
Sub-PRs created:
  PR #129: feat/auth-refactor-core → feat/auth-refactor (MERGED)
  PR #130: feat/auth-refactor-oauth → feat/auth-refactor (MERGED)
  PR #131: feat/auth-refactor-tests → feat/auth-refactor (MERGED)

Final PR:
  PR #132: feat/auth-refactor → dev (OPEN)
```

## Safety Hooks

### pr-guard.sh

The `pr-guard.sh` hook enforces COMPLEX mode rules:

**Scenario:** In COMPLEX mode with base branch `feat/auth-system`

**Allowed:**
```bash
# Sub-PR to base branch
/pr:create --head feat/auth-system-step1 --base feat/auth-system
✓ Allowed

# Final PR from base to dev (when on base branch)
git checkout feat/auth-system
/pr:create --base dev
✓ Allowed
```

**Blocked:**
```bash
# Premature PR to dev from step branch
git checkout feat/auth-system-step1
/pr:create --base dev
✗ BLOCKED

Error:
🚫 BLOCKED: Invalid PR target for COMPLEX orchestration

You are in COMPLEX mode with base branch: feat/auth-system
Current branch: feat/auth-system-step1

COMPLEX mode policy:
  - Sub-PRs must target the base branch (feat/auth-system), not dev
  - Only the final PR from base branch to dev is allowed

Correct approach:
  1. Create sub-PRs: /pr:create --head feat/auth-system-step1 --base feat/auth-system
  2. After all sub-PRs merged, create final PR from feat/auth-system to dev
```

## Output Format

### Success (New PR)

```
Creating pull request...

PR created: #127
  Title: Add user authentication system
  Head: feature-auth
  Base: dev
  URL: https://github.com/user/repo/pull/127
  Status: OPEN
```

### Success (Existing PR)

```
Checking for existing PR...

PR already exists: #127
  Title: Add user authentication system
  Head: feature-auth
  Base: dev
  URL: https://github.com/user/repo/pull/127
  Status: OPEN
```

### Error Cases

```
Error: Branch 'feature-x' does not exist
Error: No commits between feature-x and dev
Error: Authentication required - run 'gh auth login'
```

## Advanced Usage

### With Issue Linking

PRs automatically link to issues when:
1. Branch name contains issue number: `feat/42-auth-system`
2. Commit messages reference issue: "Fixes #42"
3. PR body mentions issue: "Closes #42"

**Example:**
```bash
# Create worktree with issue
/worktree:create auth-impl --issue 42

# Work on feature...

# Create PR (automatically links to #42)
/pr:create
```

**Result:**
```
PR created: #127
  Title: Implement authentication system
  Body: [auto-generated]
        ...
        Closes #42
  URL: https://github.com/user/repo/pull/127
```

### Auto-Fill from Commits

By default, `--fill` is used to generate title and body from commits:

```bash
# Your commits:
git log --oneline
abc123 Add JWT token validation
def456 Implement login endpoint
ghi789 Add password hashing

# PR created with:
/pr:create

# Results in:
Title: Add JWT token validation
Body:
  - Add JWT token validation
  - Implement login endpoint
  - Add password hashing
```

### Manual Title/Body

Override auto-fill:

```bash
/pr:create \
  --title "Implement user authentication" \
  --body "This PR adds JWT-based authentication with:
- Login/logout endpoints
- Token refresh mechanism
- Password hashing with bcrypt
- OAuth integration (Google, GitHub)

## Testing
- Added unit tests for all endpoints
- Integration tests for full auth flow

## Migration
- No database migrations required
- Compatible with existing user table

Closes #42"
```

## Integration with gh CLI

The `/pr:create` command wraps `gh pr create`:

**Underlying Command:**
```bash
gh pr create \
  --head <head-branch> \
  --base <base-branch> \
  --fill
```

**With Custom Metadata:**
```bash
gh pr create \
  --head <head-branch> \
  --base <base-branch> \
  --title "Title here" \
  --body "Body here"
```

## Workflow Patterns

### Pattern 1: Feature Branch PR

```bash
# Create feature branch
git checkout -b feature/user-notifications dev

# Implement feature
# ... make changes ...

# Create PR
/pr:create
# → Creates PR: feature/user-notifications → dev
```

### Pattern 2: Worktree-Based PR

```bash
# Create worktree
/worktree:create notifications --issue 50 --agent me --lock

# Work in worktree
/worktree:run notifications npm test

# Create PR from worktree
/pr:create --head worktree/50-notifications-me --base dev
```

### Pattern 3: Multi-Step Complex PR

```bash
# Base branch
git checkout -b feat/notifications dev

# Step 1
git checkout -b feat/notifications-backend feat/notifications
# ... implement backend ...
/pr:create --head feat/notifications-backend --base feat/notifications
# → PR #140: backend → feat/notifications

# Merge #140 to feat/notifications

# Step 2
git checkout -b feat/notifications-frontend feat/notifications
# ... implement frontend ...
/pr:create --head feat/notifications-frontend --base feat/notifications
# → PR #141: frontend → feat/notifications

# Merge #141 to feat/notifications

# Final PR
git checkout feat/notifications
/pr:create --base dev
# → PR #142: feat/notifications → dev
```

### Pattern 4: Hotfix PR

```bash
# Create hotfix from production
git checkout -b hotfix/critical-bug production

# Fix bug
# ... changes ...

# Create PR to production
/pr:create --base production

# Also backport to dev
/pr:create --base dev
```

## Best Practices

1. **Use Idempotent Calls**
   - Safe to call multiple times
   - Won't create duplicates

2. **Trust Auto-Fill**
   - Commit messages become PR description
   - Write good commit messages

3. **Link to Issues**
   - Use issue numbers in branch names
   - Reference issues in commits

4. **Review Before Merging**
   - PRs are just proposals
   - Review, discuss, iterate

5. **Use Draft PRs**
   - For early feedback
   - For work-in-progress

6. **Clean Up Branches**
   - After PR merged
   - Use GitHub's auto-delete

## Troubleshooting

### "PR already exists"

This is normal with idempotent calls:
```bash
/pr:create
# → PR already exists: #127
```

**Resolution:** This is expected behavior. Use the existing PR.

### "No commits between branches"

Your branch has no new commits:
```bash
Error: No commits between feature-x and dev
```

**Resolution:** Make commits before creating PR.

### "Branch does not exist"

Specified branch not found:
```bash
Error: Branch 'feature-x' does not exist
```

**Resolution:** Check branch name, ensure it's pushed to remote.

### "Authentication required"

GitHub CLI not authenticated:
```bash
Error: Authentication required - run 'gh auth login'
```

**Resolution:**
```bash
gh auth login
```

### Hook Blocks PR

pr-guard.sh blocks invalid PR:
```bash
🚫 BLOCKED: Invalid PR target for COMPLEX orchestration
```

**Resolution:** Follow the guidance in the error message. In COMPLEX mode, sub-PRs must target base branch, not dev.

---

**Next:** [Workflows Documentation](../workflows.md) for common patterns.
