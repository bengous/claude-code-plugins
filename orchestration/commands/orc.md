---
description: Parallel multi-agent orchestration for complex features
argument-hint: <complex-task>
---

# Parallel orchestration workflow

<principles>
- **Complex work only**: Use for multi-module features requiring parallel execution
- **Inline exploration**: Explore codebase directly using Glob and Grep
- **Multi-architect consensus**: 2-3 architect agents design from different angles
- **Git worktree stacks**: Uses `git-wt --stack` for isolated parallel development
- **Single checkpoint**: Approve once before execution

> **Dependency**: Requires `git-worktree` plugin installed (`/plugin install git-worktree@bengous-plugins` then `/git-worktree:worktree-setup`).
</principles>

---

<phase_1 title="Understand & Plan">

**Goal**: Gather context, get architect consensus, and get approval

Initial request: $ARGUMENTS

### Step 1: Create TodoWrite

Before anything else, create a TodoWrite tracking all 3 phases:

```
- Phase 1: Understand & Plan
- Phase 2: Execute
- Phase 3: Review & Ship
```

Mark Phase 1 as in_progress. Update status throughout workflow.

### Step 2: Inline Exploration

Explore the codebase directly using Glob and Grep. Batch file reads when possible - read multiple files in a single tool call for faster context building.

1. Find relevant files (Glob for patterns, Grep for keywords)
2. Read key files to understand patterns, conventions, integration points
3. Summarize: relevant code, patterns to follow, files to change

### Step 3: Clarify If Needed

Ask about scope, design preferences, or edge cases only if truly ambiguous. Proceed autonomously when requirements are reasonably clear.

### Step 4: Define Chunks

Break into 2-4 independent chunks with minimal file overlap:

```
Chunk 1: [Name] - [Description]
  Files: [list]
Chunk 2: [Name] - [Description]
  Files: [list]
```

### Step 5: Architect Consensus

Spawn **2-3 architect agents in parallel** (single message, parallel execution):

| Agent | Focus | Prompt suffix |
|-------|-------|---------------|
| Minimal | Smallest diff, max reuse | "Focus: smallest diff, maximum code reuse, least disruption." |
| Clean | Maintainability | "Focus: maintainability, clear abstractions, long-term health." |
| Pragmatic | Ship-ready | "Focus: practical trade-offs, ship-ready approach." |

Each agent receives: Feature description, codebase findings, chunk breakdown, constraints.

**Form consensus**: Analyze all proposals → identify common elements → synthesize ONE approach with best ideas from each.

### Step 6: Create Base Branch

Use prefix: `feat/` | `fix/` | `refactor/` | `chore/` based on task type.

```bash
git fetch origin && git checkout -b <prefix>/<name> origin/<base-branch>
```

### Step 7: Present and Get Approval

Present: architecture approach, chunk breakdown, base branch.

**CHECKPOINT: "Approve execution? (yes/no)"** → Yes: Phase 2 | No: Revise or abort

</phase_1>

---

<phase_2 title="Execute">

**Goal**: Implement in parallel using git worktrees

Mark Phase 2 as in_progress. Delegate to subagents - orchestrate, don't implement.

### Step 1: Planning

Spawn planning coordinator with: chunks, architecture, base branch, issue number (if any).

Coordinator returns YAML execution plan with `stack_id`, root/child worktree paths, branches, file assignments, merge order.

### Step 2: Parallel Implementation

Spawn agents **in parallel** (one per chunk, single message) to implement each chunk:

Each agent receives: worktree path, branch, chunk description, architecture guidance, key files.

Agent instructions: Implement assigned chunk only. Stay in scope. Return: files changed, summary, notes for merge coordinator.

Wait for ALL agents. If blocking errors → STOP, inform user. If successful → proceed.

### Step 3: Merging

Spawn merge coordinator with: execution plan (YAML), implementation summaries, stack_id, root/base branches.

Merge coordinator: merges children to root sequentially, resolves conflicts, cleans up worktrees (keeps root branch for PR).

</phase_2>

---

<phase_3 title="Review & Ship">

**Goal**: Quality validation and PR creation

Mark Phase 3 as in_progress.

### Step 1: Quality Review

Spawn 1-2 reviewer agents. Focus: simplicity/DRY, bugs, code quality. Return findings by severity (HIGH/MEDIUM/LOW).

### Step 2: Handle Findings

- HIGH severity → STOP, present to user, get direction
- MEDIUM/LOW → Report but proceed

### Step 3: Create PR

```bash
gh pr create --head <root-branch> --base <base-branch> \
  --title "[type]: [description]" \
  --body "## Summary\n[What was built]\n\n## Changes\n[Key changes]\n\n## Test Plan\n[How to verify]"
```

### Step 4: Summary

Mark all todos complete. Present: what was built, key decisions, stack ID, chunks, files modified, PR URL, next steps.

</phase_3>

---

<important_notes>

### Git Worktree Stacks
Uses `git-wt --stack`: creates stack, returns JSON with paths/branches. Children merge to root, root PRs to base. Cleanup via `git-wt --stack-cleanup`.

### Git Hooks
Pre-commit/pre-push hooks handle linting, type checking, tests automatically.

### Subagent Communication
Subagents are stateless: no TodoWrite access, no follow-up messages, communicate only via final return.

### Concurrency
Worktree stacks provide isolation. Agents work in separate directories under `<repo>.wt/`.

### When to Stop
Stop and inform user if: `git-wt` unavailable, blocking agent errors, unresolvable conflicts, scope creep, HIGH severity findings.

### Context Management

For long orchestrations approaching context limits:
1. Save progress to `.claude/orc-checkpoint.yaml` (phase, step, state)
2. Summarize completed work for potential continuation
3. Inform user: "Context limit approaching. State saved to .claude/orc-checkpoint.yaml" (TODO: /orc:resume coming soon)

Monitor context usage throughout. Prioritize completing current phase before checkpointing.

</important_notes>
