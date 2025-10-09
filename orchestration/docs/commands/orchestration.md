# Orchestration Commands

Reference for task orchestration and multi-agent coordination.

## Overview

Orchestration commands provide intelligent task routing with automatic complexity classification and structured execution paths.

## Command List

1. [/orc](#orc) - Alias to /orc:start
2. [/orc:start](#orcstart) - Plan and execute with routing

---

## /orc

**Description:** Alias for `/orc:start`. Main entry point for orchestration.

**Usage:**
```bash
/orc "<task_description>" [options]
```

See [/orc:start](#orcstart) for full documentation.

---

## /orc:start

**Description:** Plan, classify, and execute a task using SIMPLE/MEDIUM/COMPLEX routing.

**Usage:**
```bash
/orc:start "<task_description>" [options]
```

**Arguments:**
- `<task_description>` (required) - Natural language task description

**Options:**
- `--issue N` - Link to GitHub issue number
- `--base <branch>` - Base branch for divergence (default: `dev`)
- `--confirm` - Require approval before execution
- `--force-path simple|medium|complex` - Skip classification, use specific path

**Execution Flow:**

1. **PHASE 1: Plan Mode** - Task classification
2. **PHASE 2: Execution** - Route to appropriate path
3. **Completion** - State update and PR creation

### Phase 1: Plan Mode

The orchestration system analyzes the task and classifies it:

#### Classification Criteria

**SIMPLE Path:**
- Single-file edits or documentation
- Simple bug fixes (typos, obvious errors)
- No cross-module dependencies
- <30 lines of changes
- Low risk

**MEDIUM Path:**
- Single feature within one module
- May require new files within existing architecture
- Self-contained changes
- Moderate risk
- Can be delegated to worktree if needed

**COMPLEX Path:**
- Multiple coordinated changes
- Cross-module refactoring or integrations
- Needs decomposition into steps
- High risk
- Requires dedicated base branch + sub-PRs

#### Classification Output

After analysis, you'll see:

```
Task Classification: COMPLEX

Path chosen: COMPLEX
Rationale:
  • Task requires changes across multiple modules (auth, user, API)
  • Cross-cutting concern with authentication system
  • High risk of breaking existing functionality
  • Benefits from incremental review via sub-PRs

Execution approach:
  1. Create base branch: feat/auth-system
  2. Decompose into 3 logical steps
  3. Create sub-PR for each step → base branch
  4. Final PR: base branch → dev

[Waiting for approval...]
```

### Phase 2: Execution

Once classified (and approved if `--confirm`), execution proceeds:

#### SIMPLE Path Execution

```
1. Acquire lock on current branch
2. Make changes directly
3. Commit changes
4. Create PR to base branch (default: dev)
5. Release lock
```

**Example:**
```bash
/orc:start "Fix typo in README"

# → Classifies as SIMPLE
# → Edits README.md
# → Commits changes
# → Creates PR to dev
# → [ORC_COMPLETED]
```

#### MEDIUM Path Execution

```
1. Acquire lock on branch
2. Assess risk
3. If risky: Create worktree for isolation
4. Otherwise: Work on current branch
5. Implement feature/fix
6. Create PR to base branch (default: dev)
7. Release lock
```

**Example:**
```bash
/orc:start "Add user profile page" --confirm

# → Classifies as MEDIUM
# → Determines isolation needed
# → Creates worktree: profile-page
# → Implements profile UI and API
# → Creates PR to dev
# → [ORC_COMPLETED]
```

#### COMPLEX Path Execution

```
1. Create dedicated base branch (e.g., feat/auth-system)
2. Acquire lock on base branch
3. Decompose task into logical steps
4. FOR EACH STEP:
   a. Create step branch from base
   b. Implement step
   c. Create sub-PR: step → base branch (NOT dev)
   d. Merge to base branch
5. After all steps complete:
   a. Create final PR: base → dev
   b. Wait for human review
6. Release lock
```

**Example:**
```bash
/orc:start "Refactor authentication system" --issue 42 --confirm

# → Classifies as COMPLEX
# → Creates base: feat/auth-refactor
# → Decomposes into steps:
#     1. Core auth module
#     2. OAuth integration
#     3. Tests + docs
# → Creates sub-PR for each step
# → Creates final PR to dev
# → [ORC_COMPLETED]
```

## State Management

### Current State

`.claude/run/current.json` tracks active orchestration:

```json
{
  "type": "COMPLEX",
  "base": "feat/auth-refactor",
  "status": "executing",
  "worktree": null
}
```

**Status Values:**
- `planning` - Classification in progress
- `executing` - Implementation in progress
- `completed` - Task finished
- `aborted` - Stopped due to error

### Run History

`.claude/run/{RUN_ID}.json` preserves historical record:

```json
{
  "run_id": "2025-10-09-143052",
  "type": "COMPLEX",
  "task": "Refactor authentication system",
  "issue": 42,
  "base_branch": "feat/auth-refactor",
  "status": "completed",
  "steps": [
    {
      "name": "Core auth module",
      "branch": "feat/auth-refactor-core",
      "pr_url": "https://github.com/user/repo/pull/123",
      "status": "completed",
      "merged_at": "2025-10-09T15:30:00Z"
    },
    {
      "name": "OAuth integration",
      "branch": "feat/auth-refactor-oauth",
      "pr_url": "https://github.com/user/repo/pull/124",
      "status": "completed",
      "merged_at": "2025-10-09T16:15:00Z"
    },
    {
      "name": "Tests + documentation",
      "branch": "feat/auth-refactor-tests",
      "pr_url": "https://github.com/user/repo/pull/125",
      "status": "completed",
      "merged_at": "2025-10-09T17:00:00Z"
    }
  ],
  "pr_url": "https://github.com/user/repo/pull/126",
  "started_at": "2025-10-09T14:30:52Z",
  "completed_at": "2025-10-09T17:15:30Z"
}
```

## Concurrency Control

### Locks

Before any orchestration work, locks are acquired:

```json
// .claude/run/locks/feat-auth-refactor.lock
{
  "agent": "me",
  "branch": "feat/auth-refactor",
  "run_id": "2025-10-09-143052",
  "timestamp": "2025-10-09T14:30:52Z"
}
```

**Lock Behavior:**
- Prevents concurrent work on same branch
- Automatically released on completion
- Can be manually inspected/released if needed

### Lock Conflicts

If a lock exists:

```
Error: Branch feat/auth-refactor is locked
  Owner: subagent1
  Since: 2025-10-09T13:00:00Z
  Run ID: 2025-10-09-130000

Cannot acquire lock. Wait for completion or manually release.
```

## Safety Hooks

Three hooks enforce orchestration rules:

### 1. planmode.sh (UserPromptSubmit)

Enforces planning phase for `/orc:start`:

```
📋 Plan Mode Enforced for /orc:start

You must:
1. Analyze the task
2. Classify as SIMPLE/MEDIUM/COMPLEX
3. Present your plan and rationale
4. Wait for user approval before execution

Please proceed with PHASE 1: Task Classification.
```

**Purpose:** Prevents skipping directly to execution without thinking.

### 2. pr-guard.sh (PreToolUse → SlashCommand)

Enforces COMPLEX mode PR rules:

```
🚫 BLOCKED: Invalid PR target for COMPLEX orchestration

You are in COMPLEX mode with base branch: feat/auth-system
Current branch: feat/auth-system-core

COMPLEX mode policy:
  - Sub-PRs must target the base branch (feat/auth-system), not dev
  - Only the final PR from base branch to dev is allowed

Correct approach:
  1. Create sub-PRs: /pr:create --head feat/auth-system-core --base feat/auth-system
  2. After all sub-PRs merged, create final PR: /pr:create --head feat/auth-system --base dev
```

**Purpose:** Prevents premature PRs to dev during multi-step workflows.

### 3. worktree-guard.py (PreToolUse → Bash)

Prevents raw git worktree commands:

```
🚫 Blocked raw git worktree command: git worktree add ../new-worktree

This bypasses worktree management. Use the CLI instead:
  • /worktree:create <name>      create worktree safely
  • /worktree:delete <name>      remove worktree
```

**Purpose:** Maintains metadata consistency.

## Advanced Usage

### Force Specific Path

Skip classification and force a path:

```bash
# Force COMPLEX even for simple task
/orc:start "Update config" --force-path complex

# Force SIMPLE to skip worktree isolation
/orc:start "Add feature" --force-path simple
```

### Custom Base Branch

Diverge from non-dev branch:

```bash
# Use staging as base
/orc:start "Hotfix production issue" --base staging

# Will create PRs targeting staging instead of dev
```

### Issue Integration

Link orchestration to GitHub issue:

```bash
# Create issue first
/issue:create issue-title="Add OAuth login" priority=high
# → Issue #50 created

# Start orchestration with issue
/orc:start "Implement OAuth login with Google and GitHub" --issue 50 --confirm

# Orchestration automatically:
# • Fetches issue context
# • Updates issue with progress comments
# • Links PRs to issue
# • Closes issue on completion (optional)
```

### Confirmation Mode

Require approval before execution:

```bash
/orc:start "Major refactoring" --confirm

# → Shows plan
# → Waits for approval
# → User types: "approved" or "yes"
# → Proceeds with execution
```

## Examples

### Example 1: Documentation Update (SIMPLE)

```bash
/orc:start "Add installation instructions to README"

# Classification: SIMPLE
# • Single file (README.md)
# • Low risk
# • <30 lines

# Execution:
# 1. Edit README.md
# 2. Commit changes
# 3. Create PR to dev
# Result: PR #127 created
```

### Example 2: New Feature (MEDIUM)

```bash
/orc:start "Add user notification system" --confirm

# Classification: MEDIUM
# • Single domain (notifications)
# • Isolated from other modules
# • Moderate complexity

# Execution:
# 1. Create worktree (for isolation)
# 2. Implement notification service
# 3. Add API endpoints
# 4. Add UI components
# 5. Create PR to dev
# Result: PR #128 created from worktree branch
```

### Example 3: Architectural Change (COMPLEX)

```bash
/orc:start "Migrate from REST to GraphQL API" --issue 55 --confirm

# Classification: COMPLEX
# • Cross-cutting change (API, frontend, database)
# • High risk
# • Multiple coordinated changes

# Execution:
# 1. Create base: feat/graphql-migration
# 2. Decompose:
#    • Step 1: GraphQL schema + resolvers
#    • Step 2: Frontend Apollo client setup
#    • Step 3: Migrate existing queries
#    • Step 4: Deprecate REST endpoints
# 3. Create sub-PRs for each step → feat/graphql-migration
# 4. Merge each sub-PR after review
# 5. Create final PR: feat/graphql-migration → dev
# Result: PR #129 (final) with 4 sub-PRs merged
```

## Troubleshooting

### Classification Seems Wrong

Override with `--force-path`:

```bash
/orc:start "Task" --force-path medium
```

### Stuck in Planning

Approval marker may be missing:

```bash
# Check marker
ls .claude/run/orc-plan-approved

# Create marker manually if needed
touch .claude/run/orc-plan-approved
```

### Lock Won't Release

Manually release lock:

```bash
# Check locks
ls .claude/run/locks/

# Remove specific lock
rm .claude/run/locks/feat-branch.lock
```

### State Corruption

Reset orchestration state:

```bash
# Backup current state
cp .claude/run/current.json .claude/run/current.json.bak

# Reset
rm .claude/run/current.json

# Start fresh
/orc:start "New task"
```

## Best Practices

1. **Use --confirm for Complex Tasks**
   - Review plan before execution
   - Catch classification errors early

2. **Link to Issues**
   - Use `--issue N` for traceability
   - Automatic progress tracking

3. **Trust the Classification**
   - The system is conservative
   - Override only when necessary

4. **Review Sub-PRs Incrementally**
   - In COMPLEX mode, review each step
   - Easier than reviewing one giant PR

5. **Clean Up State**
   - Let orchestration complete naturally
   - Avoid manual state manipulation

---

**Next:** [PR Commands](pr.md) for pull request automation.
