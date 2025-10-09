# Architecture

This document explains the design principles, system architecture, and core concepts of the Claude Orchestration plugin.

## Table of Contents

1. [Overview](#overview)
2. [Core Concepts](#core-concepts)
3. [System Components](#system-components)
4. [Execution Paths](#execution-paths)
5. [State Management](#state-management)
6. [Concurrency Control](#concurrency-control)
7. [Safety Hooks](#safety-hooks)
8. [Data Flow](#data-flow)

## Overview

The Claude Orchestration plugin is designed to manage complex development workflows by:

1. **Intelligent Task Routing** - Automatically classifying tasks by complexity
2. **Isolated Environments** - Using git worktrees for parallel development
3. **Safety Guarantees** - Enforcing workflow rules through automatic hooks
4. **State Persistence** - Maintaining orchestration state across sessions
5. **PR Automation** - Streamlining pull request workflows

### Design Principles

1. **Progressive Complexity** - Simple tasks stay simple, complex tasks get appropriate structure
2. **Fail-Safe Defaults** - Conservative behavior with explicit opt-in for risky operations
3. **Idempotency** - Commands can be safely re-run without side effects
4. **Auditability** - All operations leave state trails for debugging
5. **Composability** - Commands work together in coherent workflows

## Core Concepts

### 1. Orchestration Paths

The system provides three execution paths based on task complexity:

```
Task Input → Classification → Route to Path → Execute → Create PR
```

#### Path Selection Criteria

| Aspect | SIMPLE | MEDIUM | COMPLEX |
|--------|--------|--------|---------|
| **Scope** | Single file | Single module | Multiple modules |
| **Risk** | Low | Moderate | High |
| **Lines Changed** | <30 | <500 | >500 or unknown |
| **Dependencies** | None | Isolated | Cross-cutting |
| **Isolation** | Current branch | Optional worktree | Dedicated base branch |
| **PRs** | 1 direct PR | 1 PR | Multiple sub-PRs + final PR |

### 2. Worktree Management

Git worktrees allow multiple working directories from a single repository:

```
Repository
├── Main Worktree (your-project/)
│   └── Branch: main
├── Worktree A (../worktree-feature-x/)
│   └── Branch: worktree/123-feature-x
└── Worktree B (../worktree-feature-y/)
    └── Branch: worktree/456-feature-y-agent1
```

**Benefits:**
- Parallel development without branch switching
- Isolated dependencies (separate node_modules, .venv, etc.)
- Agent delegation with exclusive locks
- Easy cleanup without affecting main worktree

### 3. State Management

The plugin maintains state in `.claude/` directory:

```
.claude/
├── run/                      # Orchestration state
│   ├── current.json          # Active orchestration
│   ├── {RUN_ID}.json         # Historical runs
│   ├── locks/                # Branch locks
│   │   └── {branch}.lock
│   └── orc-plan-approved     # Approval markers
└── worktrees/                # Worktree metadata
    └── {name}.json
```

### 4. Concurrency Control

Locks prevent concurrent work on the same branch:

```json
// .claude/run/locks/feat-auth.lock
{
  "agent": "me",
  "timestamp": "2025-10-09T14:30:52Z",
  "run_id": "2025-10-09-143052",
  "branch": "feat/auth-system"
}
```

Lock acquisition is atomic and checked before any branch work.

## System Components

### Component Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Claude Code CLI                        │
└────────────────────┬────────────────────────────────────┘
                     │
         ┌───────────┴───────────┐
         │                       │
    ┌────▼─────┐          ┌─────▼────┐
    │ Commands │          │  Hooks   │
    │  (32)    │          │   (3)    │
    └────┬─────┘          └─────┬────┘
         │                      │
         │                      │ PreToolUse / UserPromptSubmit
         │                      │
    ┌────▼──────────────────────▼────┐
    │     Plugin Core Logic           │
    │  • Classification               │
    │  • State Management             │
    │  • Lock Management              │
    └────┬────────────────────────────┘
         │
    ┌────▼──────────────────────┐
    │  Backend Scripts           │
    │  • scripts/worktree/       │
    │  • scripts/issue/          │
    │  • Git operations          │
    │  • GitHub CLI (gh)         │
    └────────────────────────────┘
```

### Command Categories

#### 1. Worktree Commands (19)
- **Lifecycle**: create, delete, prune
- **Status**: status, list, who
- **Control**: lock, unlock, transfer
- **Operations**: open, run, exec, merge
- **Maintenance**: doctor, bootstrap, annotate, logs
- **Guidance**: guide

#### 2. Issue Commands (8)
- **CRUD**: create, view, list
- **Updates**: comment, label, close, reopen
- **Integration**: fetch (sync with orchestration)

#### 3. Orchestration Commands (2)
- **Main**: orc (alias to orc:start)
- **Core**: orc:start (plan + execute)

#### 4. PR Commands (2)
- **Main**: pr (alias to pr:create)
- **Core**: pr:create (idempotent PR creation)

### Hook System

Three safety hooks enforce workflow rules:

```
Hook Registration (plugin.json)
├── PreToolUse → Bash
│   └── worktree-guard.py
├── PreToolUse → SlashCommand
│   └── pr-guard.sh
└── UserPromptSubmit
    └── planmode.sh
```

## Execution Paths

### SIMPLE Path Flow

```
User: /orc:start "Fix typo in README"
  │
  ├─► [PHASE 1] Classification
  │   └─► Analysis: <30 lines, single file, low risk
  │       → SIMPLE
  │
  ├─► [PHASE 2] Execution
  │   ├─► Acquire lock on current branch
  │   ├─► Make changes directly
  │   ├─► Commit changes
  │   ├─► Create PR to dev
  │   └─► Release lock
  │
  └─► [COMPLETE] PR created
```

### MEDIUM Path Flow

```
User: /orc:start "Add user profile page"
  │
  ├─► [PHASE 1] Classification
  │   └─► Analysis: isolated feature, single module, moderate risk
  │       → MEDIUM
  │
  ├─► [PHASE 2] Execution
  │   ├─► Risk assessment
  │   ├─► [if risky] Create worktree
  │   │   └─► /worktree:create profile --lock
  │   ├─► [else] Work on current branch
  │   ├─► Implement feature
  │   ├─► Create PR to dev
  │   └─► Release lock
  │
  └─► [COMPLETE] PR created
```

### COMPLEX Path Flow

```
User: /orc:start "Refactor authentication system" --issue 42
  │
  ├─► [PHASE 1] Classification
  │   └─► Analysis: multi-module, cross-cutting, high risk
  │       → COMPLEX
  │
  ├─► [PHASE 2] Execution
  │   ├─► Create base branch: feat/auth-refactor (from dev)
  │   ├─► Acquire lock on base branch
  │   ├─► Decompose into steps:
  │   │   ├─ Step 1: Core auth module
  │   │   ├─ Step 2: OAuth integration
  │   │   └─ Step 3: Tests + docs
  │   │
  │   ├─► FOR EACH STEP:
  │   │   ├─► Create step branch from base
  │   │   ├─► Implement step
  │   │   ├─► Create sub-PR → base branch
  │   │   │   (NOT dev! pr-guard enforces this)
  │   │   └─► Merge to base branch
  │   │
  │   ├─► After all steps complete:
  │   │   └─► Create final PR: base → dev
  │   │
  │   └─► Release lock
  │
  └─► [COMPLETE] Final PR ready for review
```

## State Management

### State Files

#### current.json
Tracks active orchestration:

```json
{
  "type": "COMPLEX",
  "base": "feat/auth-refactor",
  "status": "executing",
  "worktree": "auth-core"
}
```

#### {RUN_ID}.json
Historical record of each run:

```json
{
  "run_id": "2025-10-09-143052",
  "type": "COMPLEX",
  "task": "Refactor authentication system",
  "issue": 42,
  "base_branch": "feat/auth-refactor",
  "status": "executing",
  "steps": [
    {
      "name": "Core auth module",
      "branch": "feat/auth-refactor-core",
      "pr_url": "https://github.com/user/repo/pull/123",
      "status": "completed"
    },
    {
      "name": "OAuth integration",
      "branch": "feat/auth-refactor-oauth",
      "status": "in_progress"
    }
  ],
  "pr_url": null,
  "started_at": "2025-10-09T14:30:52Z",
  "updated_at": "2025-10-09T15:45:20Z"
}
```

#### worktree metadata
Each worktree has metadata:

```json
// .claude/worktrees/auth-core.json
{
  "name": "auth-core",
  "branch": "worktree/42-auth-core-me",
  "path": "../worktree-auth-core",
  "issue": 42,
  "agent": "me",
  "locked": true,
  "created_at": "2025-10-09T14:35:12Z",
  "annotations": [
    "Working on JWT implementation",
    "Added social OAuth providers"
  ]
}
```

### State Transitions

```
Orchestration Lifecycle:
  null → planning → executing → completed
         ↓
      aborted (on error)
```

```
Worktree Lifecycle:
  create → locked → active → unlocked → delete
           ↓                    ↑
           └─── transferred ────┘
```

## Concurrency Control

### Lock Mechanism

Locks ensure exclusive access to branches:

```python
# Pseudocode for lock acquisition
def acquire_lock(branch, agent, run_id):
    lock_path = f".claude/run/locks/{branch}.lock"

    if os.path.exists(lock_path):
        lock = read_json(lock_path)
        if lock["agent"] != agent:
            raise LockError(f"Branch locked by {lock['agent']}")

    write_json(lock_path, {
        "agent": agent,
        "branch": branch,
        "run_id": run_id,
        "timestamp": now()
    })
```

### Lock Checks

All operations check locks before proceeding:

1. **Worktree operations** - Check worktree lock
2. **Branch operations** - Check branch lock
3. **PR creation** - Check target branch lock
4. **Merge operations** - Check both source and target locks

## Safety Hooks

### Hook Architecture

```
User Action
    │
    ├─► UserPromptSubmit Hook
    │   └─► planmode.sh
    │       └─► Enforce planning for /orc:start
    │
    ├─► PreToolUse Hook (Bash)
    │   └─► worktree-guard.py
    │       └─► Block raw git worktree commands
    │
    └─► PreToolUse Hook (SlashCommand)
        └─► pr-guard.sh
            └─► Enforce COMPLEX mode PR rules
```

### Hook Execution Flow

```
1. User submits prompt/command
2. Claude Code triggers appropriate hooks
3. Hook reads context (stdin JSON)
4. Hook validates operation
5. Hook either:
   • exit 0 → Allow operation
   • exit 1 → Block with error message
   • exit 2 → Block with guidance message
```

## Data Flow

### Complete Workflow Example

```
┌──────────────────────────────────────────────────────────┐
│ 1. User: /orc:start "Add OAuth" --issue 42              │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ├─► planmode.sh hook validates
                     │
┌────────────────────▼─────────────────────────────────────┐
│ 2. PHASE 1: Classification                               │
│    • Analyze task complexity                             │
│    • Classify as COMPLEX                                 │
│    • Write .claude/run/current.json                      │
│    • Generate RUN_ID                                     │
│    • Write .claude/run/{RUN_ID}.json                     │
└────────────────────┬─────────────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────────────┐
│ 3. PHASE 2: Create Base Branch                           │
│    • git checkout -b feat/oauth origin/dev               │
│    • Acquire lock: .claude/run/locks/feat-oauth.lock     │
│    • Update state: status="executing"                    │
└────────────────────┬─────────────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────────────┐
│ 4. Decompose into Steps                                  │
│    • Step 1: OAuth providers                             │
│    • Step 2: Token handling                              │
│    • Step 3: Tests                                       │
└────────────────────┬─────────────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────────────┐
│ 5. Execute Step 1                                        │
│    • git checkout -b feat/oauth-providers feat/oauth     │
│    • Implement OAuth providers                           │
│    • /pr:create --head feat/oauth-providers              │
│                 --base feat/oauth                        │
│    • pr-guard.sh validates target                        │
│    • PR created: #123 → feat/oauth                       │
│    • Merge #123 to feat/oauth                            │
└────────────────────┬─────────────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────────────┐
│ 6. Execute Step 2 & 3 (similar to step 1)               │
│    • Create branches, implement, create sub-PRs          │
│    • All PRs target feat/oauth base branch               │
└────────────────────┬─────────────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────────────┐
│ 7. Create Final PR                                       │
│    • git checkout feat/oauth                             │
│    • /pr:create --head feat/oauth --base dev             │
│    • pr-guard.sh allows (from base branch)               │
│    • PR created: #124 → dev                              │
└────────────────────┬─────────────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────────────┐
│ 8. Complete                                              │
│    • Release lock: rm .claude/run/locks/feat-oauth.lock  │
│    • Update state: status="completed"                    │
│    • Update current.json                                 │
│    • Print [ORC_COMPLETED]                               │
└──────────────────────────────────────────────────────────┘
```

## Design Decisions

### Why Three Paths?

The three-path system balances:
- **Simplicity** for trivial tasks (SIMPLE)
- **Isolation** for moderate work (MEDIUM)
- **Structure** for complex changes (COMPLEX)

Without this, all tasks would either be too constrained or too free-form.

### Why Git Worktrees?

Worktrees provide:
1. **True isolation** - Separate file trees, no shared state
2. **Parallel work** - Multiple tasks without branch switching
3. **Agent delegation** - Different agents in different worktrees
4. **Easy cleanup** - Remove worktree without affecting main tree

### Why State Persistence?

State files enable:
1. **Resume** - Continue after Claude Code restart
2. **Audit** - Track orchestration history
3. **Debugging** - Investigate failures
4. **Concurrency** - Prevent conflicts via locks

### Why Safety Hooks?

Hooks prevent common mistakes:
1. **worktree-guard** - Maintains metadata consistency
2. **pr-guard** - Prevents premature merges to main branches
3. **planmode** - Ensures thoughtful task classification

## Performance Considerations

### Worktree Overhead

Each worktree creates a new file tree:
- Disk space: ~size of working directory
- Creation time: Fast (git operation)
- Recommendation: Clean up unused worktrees regularly

### State File Size

State files are small JSON:
- current.json: <1KB
- {RUN_ID}.json: <10KB
- Lock files: <500 bytes
- Total overhead: Negligible

### Lock Contention

Locks are file-based:
- No network required
- Atomic file operations
- Low contention in typical workflows

## Extension Points

The architecture supports extensions:

1. **New Commands** - Add commands/*.md files
2. **Custom Hooks** - Add hooks to plugin.json
3. **Backend Scripts** - Add scripts for complex operations
4. **State Extensions** - Add fields to state JSON

---

**Next:** [Command Reference](commands/) for detailed command documentation.
