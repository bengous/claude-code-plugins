# Worktree Commands

Comprehensive reference for all 19 worktree management commands.

## Overview

Worktree commands manage isolated git worktrees for parallel development. Each worktree has:
- Independent file tree
- Separate branch
- Lock support for exclusive access
- Metadata tracking

## Command List

1. [/worktree](#worktree) - List all managed worktrees
2. [/worktree:create](#worktreecreate) - Create new worktree
3. [/worktree:delete](#worktreedelete) - Remove worktree
4. [/worktree:status](#worktreestatus) - Show detailed status
5. [/worktree:lock](#worktreelock) - Lock for exclusive access
6. [/worktree:unlock](#worktreeunlock) - Release lock
7. [/worktree:open](#worktreeopen) - Get path and branch
8. [/worktree:run](#worktreerun) - Execute command
9. [/worktree:exec](#worktreeexec) - Execute and attach
10. [/worktree:merge](#worktreemerge) - Merge to target
11. [/worktree:prune](#worktreeprune) - Clean multiple
12. [/worktree:bootstrap](#worktreebootstrap) - Install dependencies
13. [/worktree:annotate](#worktreeannotate) - Add metadata
14. [/worktree:who](#worktreewho) - Show lock owner
15. [/worktree:logs](#worktreelogs) - View activity logs
16. [/worktree:transfer](#worktreetransfer) - Transfer ownership
17. [/worktree:attach](#worktreeattach) - Attach to worktree
18. [/worktree:doctor](#worktreedor) - Health check
19. [/worktree:guide](#worktreeguide) - Workflow patterns

---

## /worktree

**Description:** List all managed worktrees with summary information.

**Usage:**
```bash
/worktree
/worktree --json
```

**Flags:**
- `--json` - Output in JSON format

**Output:**
```
Managed Worktrees:
  • auth-core (worktree/42-auth-core-me)
    Path: ../worktree-auth-core
    Issue: #42
    Locked: yes (agent: me)

  • api-refactor (worktree/api-refactor)
    Path: ../worktree-api-refactor
    Issue: none
    Locked: no

Total: 2 worktrees
```

**Example:**
```bash
# List all worktrees
/worktree

# Get JSON for scripting
/worktree --json
```

---

## /worktree:create

**Description:** Create a new isolated worktree with optional issue tracking, agent locking, and dependency installation.

**Usage:**
```bash
/worktree:create <name> [options]
```

**Arguments:**
- `<name>` (required) - Worktree identifier (will be slugified)

**Options:**
- `--issue N` - Associate with GitHub issue number
- `--base <branch>` - Base branch to fork from (default: `dev`)
- `--agent <id>` - Agent identifier
- `--lock` - Immediately lock for the specified agent (requires `--agent`)
- `--install` - Run `pnpm install` after creation

**Branch Naming:**
- Without `--issue`: `worktree/<name>` or `worktree/<name>-<agent>`
- With `--issue N`: `worktree/<issue>-<name>` or `worktree/<issue>-<name>-<agent>`

**Examples:**
```bash
# Simple worktree
/worktree:create my-feature

# With issue tracking
/worktree:create auth-impl --issue 42

# With agent lock and dependencies
/worktree:create api-work --agent me --lock --install

# From staging branch
/worktree:create hotfix --base staging --agent me --lock
```

**Output:**
```
Creating worktree: my-feature
Branch: worktree/my-feature
Base: dev
Path: ../worktree-my-feature

Worktree created successfully!
```

**Related:**
- `/worktree:lock` - Lock after creation
- `/worktree:bootstrap` - Install dependencies later

---

## /worktree:delete

**Description:** Safely remove a worktree and its metadata.

**Usage:**
```bash
/worktree:delete <name> [--force]
```

**Arguments:**
- `<name>` (required) - Worktree name to delete

**Options:**
- `--force` - Delete even if locked or has uncommitted changes

**Safety:**
- Checks for uncommitted changes
- Prevents deletion of locked worktrees (unless --force)
- Removes metadata files
- Cleans up git worktree

**Examples:**
```bash
# Safe delete
/worktree:delete my-feature

# Force delete (dangerous!)
/worktree:delete my-feature --force
```

**Output:**
```
Deleting worktree: my-feature
✓ Removed git worktree
✓ Cleaned up metadata
Worktree deleted successfully!
```

**Related:**
- `/worktree:prune` - Delete multiple worktrees

---

## /worktree:status

**Description:** Show detailed status of all worktrees or a specific worktree.

**Usage:**
```bash
/worktree:status [name]
```

**Arguments:**
- `[name]` (optional) - Specific worktree to inspect

**Output:**
```
Worktree Status: auth-core

Name: auth-core
Branch: worktree/42-auth-core-me
Path: ../worktree-auth-core
Base: dev
Issue: #42
Agent: me
Locked: yes (by: me, at: 2025-10-09T14:30:52Z)

Git Status:
  Modified: 3 files
  Untracked: 1 file
  Ahead: 2 commits

Annotations:
  - Implemented JWT token generation
  - Added refresh token logic

Created: 2025-10-09T14:25:12Z
Updated: 2025-10-09T15:45:30Z
```

**Examples:**
```bash
# All worktrees
/worktree:status

# Specific worktree
/worktree:status auth-core
```

---

## /worktree:lock

**Description:** Lock a worktree for exclusive access by an agent.

**Usage:**
```bash
/worktree:lock <name> --agent <id>
```

**Arguments:**
- `<name>` (required) - Worktree name to lock
- `--agent <id>` (required) - Agent identifier

**Examples:**
```bash
# Lock for yourself
/worktree:lock auth-core --agent me

# Lock for subagent
/worktree:lock api-work --agent subagent1
```

**Output:**
```
Locking worktree: auth-core
Agent: me
Lock acquired successfully!
```

**Related:**
- `/worktree:unlock` - Release lock
- `/worktree:who` - Check who has lock

---

## /worktree:unlock

**Description:** Release lock on a worktree.

**Usage:**
```bash
/worktree:unlock <name>
```

**Arguments:**
- `<name>` (required) - Worktree name to unlock

**Examples:**
```bash
/worktree:unlock auth-core
```

**Output:**
```
Unlocking worktree: auth-core
Lock released successfully!
```

---

## /worktree:open

**Description:** Get path and branch information for delegating work to a worktree.

**Usage:**
```bash
/worktree:open <name>
```

**Arguments:**
- `<name>` (required) - Worktree name to open

**Output:**
```
Worktree: auth-core
Path: /home/user/projects/worktree-auth-core
Branch: worktree/42-auth-core-me
```

**Use Case:**
Typically used before delegating work to agents.

**Example:**
```bash
/worktree:open auth-core
# Then delegate to agent with the path
```

---

## /worktree:run

**Description:** Execute a command in a worktree's directory.

**Usage:**
```bash
/worktree:run <name> <command>
```

**Arguments:**
- `<name>` (required) - Worktree name
- `<command>` (required) - Command to execute

**Examples:**
```bash
# Run tests
/worktree:run auth-core npm test

# Check git status
/worktree:run auth-core git status

# Build project
/worktree:run api-work pnpm build
```

**Output:**
```
Running in worktree: auth-core
Command: npm test

[command output...]
```

---

## /worktree:exec

**Description:** Execute command in worktree and attach to output (for long-running commands).

**Usage:**
```bash
/worktree:exec <name> <command>
```

**Arguments:**
- `<name>` (required) - Worktree name
- `<command>` (required) - Command to execute

**Example:**
```bash
# Start dev server
/worktree:exec auth-core npm run dev

# Run long test suite
/worktree:exec api-work pnpm test:integration
```

---

## /worktree:merge

**Description:** Merge worktree changes to a target branch.

**Usage:**
```bash
/worktree:merge <name> --to <branch>
```

**Arguments:**
- `<name>` (required) - Worktree name
- `--to <branch>` (required) - Target branch

**Example:**
```bash
# Merge to dev
/worktree:merge auth-core --to dev

# Merge to feature branch
/worktree:merge auth-core --to feat/auth-system
```

**Safety:**
- Checks for uncommitted changes
- Validates target branch exists
- Prevents merge if locks conflict

---

## /worktree:prune

**Description:** Clean up multiple worktrees at once.

**Usage:**
```bash
/worktree:prune [--force] [--dry-run]
```

**Options:**
- `--force` - Remove locked worktrees
- `--dry-run` - Show what would be removed

**Examples:**
```bash
# See what would be pruned
/worktree:prune --dry-run

# Prune unlocked worktrees
/worktree:prune

# Force prune everything
/worktree:prune --force
```

**Output:**
```
Pruning worktrees...
  ✓ Removed: old-feature (stale, no activity in 7 days)
  ✓ Removed: test-branch (merged to dev)
  ⊘ Skipped: auth-core (locked by me)

Pruned: 2 worktrees
Skipped: 1 worktree
```

---

## /worktree:bootstrap

**Description:** Install dependencies in a worktree.

**Usage:**
```bash
/worktree:bootstrap <name> [--manager npm|pnpm|yarn]
```

**Arguments:**
- `<name>` (required) - Worktree name
- `--manager` (optional) - Package manager to use

**Examples:**
```bash
# Auto-detect package manager
/worktree:bootstrap auth-core

# Use specific manager
/worktree:bootstrap auth-core --manager pnpm
```

**Output:**
```
Bootstrapping worktree: auth-core
Package manager: pnpm
Installing dependencies...

[installation output...]

Dependencies installed successfully!
```

---

## /worktree:annotate

**Description:** Add descriptive annotation to worktree metadata.

**Usage:**
```bash
/worktree:annotate <name> <message>
```

**Arguments:**
- `<name>` (required) - Worktree name
- `<message>` (required) - Annotation message

**Examples:**
```bash
/worktree:annotate auth-core "Implemented JWT token refresh"
/worktree:annotate api-work "Fixed rate limiting bug"
```

**Use Case:**
Track progress and decisions within worktree lifecycle.

---

## /worktree:who

**Description:** Show who has lock on a worktree.

**Usage:**
```bash
/worktree:who <name>
```

**Arguments:**
- `<name>` (required) - Worktree name

**Output:**
```
Worktree: auth-core
Locked: yes
Owner: me
Since: 2025-10-09T14:30:52Z
Run ID: 2025-10-09-143052
```

---

## /worktree:logs

**Description:** View activity logs for a worktree.

**Usage:**
```bash
/worktree:logs <name> [--limit N]
```

**Arguments:**
- `<name>` (required) - Worktree name
- `--limit N` (optional) - Limit number of log entries

**Output:**
```
Activity logs: auth-core

2025-10-09 15:45:30 [ANNOTATE] Implemented JWT token refresh
2025-10-09 15:20:15 [COMMIT] Add token validation tests
2025-10-09 14:55:42 [LOCK] Locked by me
2025-10-09 14:30:52 [CREATE] Worktree created (issue: #42)
```

---

## /worktree:transfer

**Description:** Transfer worktree ownership to another agent.

**Usage:**
```bash
/worktree:transfer <name> --to <agent>
```

**Arguments:**
- `<name>` (required) - Worktree name
- `--to <agent>` (required) - New owner agent ID

**Example:**
```bash
# Transfer to subagent
/worktree:transfer auth-core --to subagent1
```

**Output:**
```
Transferring worktree: auth-core
From: me
To: subagent1

Transfer completed successfully!
```

---

## /worktree:attach

**Description:** Attach your session to a worktree (change working directory context).

**Usage:**
```bash
/worktree:attach <name>
```

**Arguments:**
- `<name>` (required) - Worktree name

**Example:**
```bash
/worktree:attach auth-core
```

**Note:** This updates Claude Code's context to work within the worktree.

---

## /worktree:doctor

**Description:** Health check and repair for worktree management system.

**Usage:**
```bash
/worktree:doctor [--fix]
```

**Options:**
- `--fix` - Automatically fix issues

**Checks:**
- Metadata consistency
- Git worktree status
- Stale locks
- Orphaned files

**Output:**
```
Running worktree health check...

✓ Metadata directory: OK
✓ Git worktrees: 2 found, 2 tracked
⚠ Stale lock found: old-feature.lock (age: 7 days)
✓ No orphaned metadata

Issues found: 1
Run with --fix to automatically repair.
```

---

## /worktree:guide

**Description:** Show worktree workflow patterns and best practices.

**Usage:**
```bash
/worktree:guide [topic]
```

**Topics:**
- `creation` - How to create worktrees effectively
- `delegation` - Multi-agent workflows
- `cleanup` - Maintenance and pruning
- `locks` - Concurrency control

**Example:**
```bash
# Show all guides
/worktree:guide

# Specific topic
/worktree:guide delegation
```

---

## Common Workflows

### Solo Development

```bash
# Create and lock
/worktree:create feature-x --agent me --lock --install

# Work in isolation
/worktree:run feature-x npm test

# Merge when done
/worktree:merge feature-x --to dev

# Clean up
/worktree:delete feature-x
```

### Multi-Agent Delegation

```bash
# Create worktree for agent
/worktree:create task-a --issue 42 --agent subagent1 --lock

# Delegate work (agent works in worktree)
/worktree:open task-a  # Get path

# Check progress
/worktree:status task-a
/worktree:logs task-a

# Transfer if needed
/worktree:transfer task-a --to subagent2

# Unlock when done
/worktree:unlock task-a
```

### Maintenance

```bash
# Check health
/worktree:doctor

# Clean up old worktrees
/worktree:prune --dry-run
/worktree:prune

# View all worktrees
/worktree:status
```

---

**Next:** [Issue Commands](issue.md) for GitHub issue management.
