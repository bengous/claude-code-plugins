---
description: Parallel multi-agent orchestration for complex features
argument-hint: <complex-task>
---

# Orchestration Workflow v2.1

## Core Principles

- **Complex work only**: Use for multi-module features requiring parallel execution
- **Inline exploration**: Explore codebase directly (no explorer agents)
- **Multi-architect consensus**: 2-3 Opus agents design from different angles
- **Git worktree isolation**: Parallel agents work in separate directories
- **Single checkpoint**: Approve once before execution

> **Note**: For simple tasks (single-module, bug fixes, small features), don't use /orc - just ask Opus directly.

---

## Phase 1: Understand & Plan

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

**Do NOT spawn explorer agents.** Explore the codebase yourself:

1. **Find relevant files**:
   - Use Glob to locate files by pattern
   - Use Grep to search for keywords, function names, patterns

2. **Read key files**:
   - Read files that are likely affected
   - Understand existing patterns and conventions
   - Note integration points

3. **Summarize findings**:
   - What exists that's relevant?
   - What patterns should we follow?
   - What files will need changes?

### Step 3: Ask Clarifying Questions (If Needed)

If requirements are ambiguous, ask the user:
- Scope boundaries (what's in/out?)
- Design preferences
- Edge cases that need handling

If clear enough, proceed without stopping.

### Step 4: Define Chunks

Break the feature into 2-4 independent chunks:

```
Chunk 1: [Name] - [Description]
  Files: [list files this chunk modifies]

Chunk 2: [Name] - [Description]
  Files: [list files this chunk modifies]

Chunk 3: [Name] - [Description]
  Files: [list files this chunk modifies]
```

Ensure chunks have minimal file overlap to avoid merge conflicts.

### Step 5: Architect Consensus

Spawn **2-3 architect agents in parallel** using Task tool:

```
Task tool (launch all in same message for parallel execution):

Agent 1 - Minimal Changes:
  subagent_type: claude-orchestration:architect
  model: opus
  prompt: "Design architecture for [feature] with MINIMAL CHANGES focus.

  Feature: [description]
  Codebase findings: [from exploration]
  Chunks: [chunk breakdown]
  Constraints: [any constraints]

  Focus on smallest diff, maximum code reuse, least disruption."

Agent 2 - Clean Architecture:
  subagent_type: claude-orchestration:architect
  model: opus
  prompt: "Design architecture for [feature] with CLEAN ARCHITECTURE focus.

  Feature: [description]
  Codebase findings: [from exploration]
  Chunks: [chunk breakdown]
  Constraints: [any constraints]

  Focus on maintainability, clear abstractions, long-term health."

Agent 3 - Pragmatic Balance:
  subagent_type: claude-orchestration:architect
  model: opus
  prompt: "Design architecture for [feature] with PRAGMATIC BALANCE focus.

  Feature: [description]
  Codebase findings: [from exploration]
  Chunks: [chunk breakdown]
  Constraints: [any constraints]

  Focus on practical trade-offs, ship-ready approach."
```

**Form consensus** from architect outputs:
1. Analyze all returned architectures
2. Identify common elements and divergences
3. Synthesize ONE recommended approach
4. Take best ideas from each perspective

### Step 6: Create Base Branch

Determine prefix based on task type:
- `feat/` for new features
- `fix/` for bug fixes
- `refactor/` for refactoring
- `chore/` for maintenance

```bash
git fetch origin
git checkout -b <prefix>/<descriptive-name> origin/dev
```

### Step 7: Present and Get Approval

Present to user:
- **Architecture approach**: Consensus summary from architects
- **Chunk breakdown**: Independent pieces with file assignments
- **Base branch**: Created branch name

**CHECKPOINT: "Approve execution? (yes/no)"**

- Yes: Proceed to Phase 2
- No: Revise or abort

---

## Phase 2: Execute

**Goal**: Implement the feature in parallel using git worktrees

Mark Phase 2 as in_progress in TodoWrite.

**CRITICAL: You are an orchestrator, not an implementer. Always delegate to subagents.**

### Step 1: Planning

Spawn planning coordinator:

```
Task tool:
  subagent_type: claude-orchestration:planning-coordinator
  prompt: "Create execution plan for parallel implementation.

  **Chunks:**
  [Chunk breakdown from Phase 1]

  **Architecture:**
  [Consensus approach from Phase 1]

  **Base branch:** [branch-name]

  **Files to read:** [key files]

  Create worktrees for each chunk and return YAML execution plan."
```

Coordinator returns execution plan with:
- Worktree paths and branches
- File assignments per chunk
- Merge order

### Step 2: Parallel Implementation

Spawn implementation agents **in parallel** (one per chunk):

```
Task tool (all in same message for parallel execution):

For each chunk:
  subagent_type: claude-orchestration:implementation
  prompt: "Implement [chunk name] in worktree.

  **Worktree path:** [from execution plan]
  **Branch:** [from execution plan]
  **Base branch:** [branch-name]

  **Your chunk:**
  [Chunk description and files]

  **Architecture guidance:**
  [Relevant portion of consensus architecture]

  **Files to read first:**
  [Key files for this chunk]

  Implement your chunk only. Stay in scope. Return completion summary."
```

Wait for ALL agents to complete.

Review summaries:
- If ANY blocking errors: STOP, inform user
- If all successful: Proceed to merging

### Step 3: Merging

Spawn merge coordinator:

```
Task tool:
  subagent_type: claude-orchestration:merge-coordinator
  prompt: "Merge all implementations to base branch.

  **Execution plan:**
  [YAML from planning coordinator]

  **Implementation summaries:**
  [Summaries from all agents]

  **Base branch:** [branch-name]

  Merge sequentially per merge_order. Resolve conflicts inline. Clean up worktrees."
```

Wait for merge coordinator to return.

---

## Phase 3: Review & Ship

**Goal**: Quality validation and PR creation

Mark Phase 3 as in_progress in TodoWrite.

### Step 1: Quality Review

Spawn 1-2 reviewer agents:

```
Task tool:
  subagent_type: general-purpose
  prompt: "Review the implementation on branch [branch-name].

  **What was built:**
  [Summary of feature]

  **Focus areas:**
  - Simplicity and DRY principles
  - Bugs and functional correctness
  - Code quality and conventions

  Review the changes and categorize findings by severity:
  - HIGH: Bugs, broken functionality, critical issues
  - MEDIUM: Design improvements, tech debt
  - LOW: Style issues, minor improvements

  Return findings with severity classifications."
```

### Step 2: Handle Findings

Consolidate reviewer findings.

**If HIGH severity issues found**:
- STOP and present to user
- Ask: Fix now? Fix later? Proceed as-is?
- Address per user direction

**If only MEDIUM/LOW**:
- Report findings but proceed automatically

### Step 3: Create PR

```bash
gh pr create --head <branch> --base dev --title "[type]: [description]" --body "## Summary
[What was built]

## Changes
[Key changes]

## Test Plan
[How to verify]"
```

### Step 4: Summary

Mark all TodoWrite items complete.

Present final summary:
- **What was built**: Feature description
- **Key decisions**: Architecture choices
- **Chunks executed**: Summary of parallel work
- **Files modified**: List of changes
- **PR URL**: Link to pull request
- **Next steps**: Suggested follow-ups

---

## Important Notes

### Git Hooks Handle Quality
Pre-commit and pre-push hooks automatically run linting, type checking, and tests. You don't need to run these manually.

### Subagent Communication
All subagents are stateless:
- Cannot access your TodoWrite
- Cannot message you after spawning
- Communicate ONLY via final return message

### Concurrency
Git worktrees provide isolation for parallel work. No locks needed - agents work in separate directories.

### When to Stop
If during execution you encounter:
- Blocking errors from any agent: Stop, inform user
- Unresolvable merge conflicts: Stop, inform user
- Scope creep beyond approved chunks: Stop, inform user
- HIGH severity review findings: Stop, get user decision

---
