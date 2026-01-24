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

### Step 1: Create Task List

Before anything else, create tasks to track all 3 phases:

```
TaskCreate(
  subject: "Phase 1: Understand & Plan",
  description: "Explore codebase, get architect consensus, obtain approval",
  activeForm: "Planning",
  metadata: {"phase": 1}
)
TaskCreate(
  subject: "Phase 2: Execute",
  description: "Create worktrees, spawn implementation agents, merge results",
  activeForm: "Executing",
  metadata: {"phase": 2}
)
TaskCreate(
  subject: "Phase 3: Review & Ship",
  description: "Quality review, create PR, present summary",
  activeForm: "Shipping",
  metadata: {"phase": 3}
)

# Mark Phase 1 as in_progress (always read state before updating)
TaskGet(taskId: "phase-1-id")
TaskUpdate(taskId: "phase-1-id", status: "in_progress")
```

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

Spawn **2-3 architect agents in parallel** using the subagent dispatch pattern:

#### Before: Pre-truncate output files
```
Write(file_path: ".claude/orc-state/architect-minimal.md", content: "")
Write(file_path: ".claude/orc-state/architect-clean.md", content: "")
Write(file_path: ".claude/orc-state/architect-pragmatic.md", content: "")
```

#### Dispatch: Spawn all architects in parallel (single message)
```
Task(
  description: "Architect: Minimal changes",
  subagent_type: "general-purpose",
  model: "opus",
  allowed_tools: ["Read", "Grep", "Glob", "Write"],
  run_in_background: true,
  prompt: """
    You are the MINIMAL architect. Focus: smallest diff, maximum code reuse, least disruption.

    Context: [Feature description, codebase findings, chunk breakdown, constraints]

    Write your architecture proposal to .claude/orc-state/architect-minimal.md

    Include: approach overview, file changes per chunk, key decisions with rationale
  """
) -> task_id: "bg-1"

Task(
  description: "Architect: Clean architecture",
  subagent_type: "general-purpose",
  model: "opus",
  allowed_tools: ["Read", "Grep", "Glob", "Write"],
  run_in_background: true,
  prompt: """
    You are the CLEAN architect. Focus: maintainability, clear abstractions, long-term health.

    Context: [Feature description, codebase findings, chunk breakdown, constraints]

    Write your architecture proposal to .claude/orc-state/architect-clean.md

    Include: approach overview, file changes per chunk, key decisions with rationale
  """
) -> task_id: "bg-2"

Task(
  description: "Architect: Pragmatic balance",
  subagent_type: "general-purpose",
  model: "opus",
  allowed_tools: ["Read", "Grep", "Glob", "Write"],
  run_in_background: true,
  prompt: """
    You are the PRAGMATIC architect. Focus: practical trade-offs, ship-ready approach.

    Context: [Feature description, codebase findings, chunk breakdown, constraints]

    Write your architecture proposal to .claude/orc-state/architect-pragmatic.md

    Include: approach overview, file changes per chunk, key decisions with rationale
  """
) -> task_id: "bg-3"
```

#### After: Collect results and verify
```
TaskOutput(task_id: "bg-1", block: true)
TaskOutput(task_id: "bg-2", block: true)
TaskOutput(task_id: "bg-3", block: true)

# Read and verify each proposal exists and has substance
Read(file_path: ".claude/orc-state/architect-minimal.md")
Read(file_path: ".claude/orc-state/architect-clean.md")
Read(file_path: ".claude/orc-state/architect-pragmatic.md")

# If any proposal is empty/invalid after 2 attempts, escalate
AskUserQuestion(questions: [{
  question: "Architect subagent failed. How to proceed?",
  header: "Retry",
  options: [
    {label: "Retry", description: "Re-run with more context"},
    {label: "Skip", description: "Use available proposals only"},
    {label: "Abort", description: "Stop orchestration"}
  ],
  multiSelect: false
}])
```

**Form consensus**: Analyze all proposals → identify common elements → synthesize ONE approach with best ideas from each.

### Step 6: Create Base Branch

Use prefix: `feat/` | `fix/` | `refactor/` | `chore/` based on task type.

```bash
git fetch origin && git checkout -b <prefix>/<name> origin/<base-branch>
```

### Step 7: Present and Get Approval

Present: architecture approach, chunk breakdown, base branch.

**CHECKPOINT: "Approve execution? (yes/no)"** → Yes: Phase 2 | No: Revise or abort

```
# Mark Phase 1 complete
TaskGet(taskId: "phase-1-id")
TaskUpdate(taskId: "phase-1-id", status: "completed")
```

</phase_1>

---

<phase_2 title="Execute">

**Goal**: Implement in parallel using git worktrees

```
# Mark Phase 2 as in_progress
TaskGet(taskId: "phase-2-id")
TaskUpdate(taskId: "phase-2-id", status: "in_progress")
```

Delegate to subagents - orchestrate, don't implement.

### Step 1: Planning

#### Before: Pre-truncate output
```
Write(file_path: ".claude/orc-state/planning-output.yaml", content: "")
```

#### Dispatch: Spawn planning coordinator
```
Task(
  description: "Create worktree stack and execution plan",
  subagent_type: "general-purpose",
  model: "opus",
  allowed_tools: ["Bash(git:*)", "Bash(git-wt:*)", "Bash(ls:*)", "Read", "Grep", "Glob", "Write"],
  run_in_background: true,
  prompt: """
    You are the planning coordinator. Create a worktree stack and execution plan.

    Input:
    - Chunks: [chunk definitions]
    - Architecture: [consensus approach]
    - Base branch: [branch name]
    - Issue number: [if any]

    Write YAML execution plan to .claude/orc-state/planning-output.yaml

    Required: stack_id, base_branch, root.path, root.branch, chunks[].path, chunks[].branch, merge_order
  """
) -> task_id: "planning-bg"
```

#### After: Collect and verify
```
TaskOutput(task_id: "planning-bg", block: true)
Read(file_path: ".claude/orc-state/planning-output.yaml")
# Verify: valid YAML, has required fields
```

Coordinator returns YAML execution plan with `stack_id`, root/child worktree paths, branches, file assignments, merge order.

### Step 2: Parallel Implementation

#### Before: Pre-truncate output files (one per chunk)
```
Write(file_path: ".claude/orc-state/impl-chunk-1.md", content: "")
Write(file_path: ".claude/orc-state/impl-chunk-2.md", content: "")
# ... for each chunk
```

#### Dispatch: Spawn agents in parallel (single message)
```
Task(
  description: "Implement Chunk 1: [name]",
  subagent_type: "general-purpose",
  allowed_tools: ["Read", "Write", "Edit", "Grep", "Glob", "Bash(git:*)", "Bash(npm:*)", "Bash(cd:*)"],
  run_in_background: true,
  prompt: """
    You are an implementation agent for Chunk 1.

    Worktree path: [from execution plan]
    Branch: [from execution plan]
    Chunk description: [what to implement]
    Architecture guidance: [from consensus]
    Key files: [from chunk definition]

    Implement assigned chunk only. Stay in scope.

    Write summary to .claude/orc-state/impl-chunk-1.md
    Include: files changed, implementation summary, notes for merge coordinator
  """
) -> task_id: "impl-1"

Task(
  description: "Implement Chunk 2: [name]",
  # ... same pattern
) -> task_id: "impl-2"

# ... for each chunk
```

#### After: Collect ALL results
```
TaskOutput(task_id: "impl-1", block: true)
TaskOutput(task_id: "impl-2", block: true)
# ... for each chunk

# Verify each implementation summary exists
Read(file_path: ".claude/orc-state/impl-chunk-1.md")
Read(file_path: ".claude/orc-state/impl-chunk-2.md")
```

Wait for ALL agents. If blocking errors → STOP, inform user. If successful → proceed.

### Step 3: Merging

#### Before: Pre-truncate output
```
Write(file_path: ".claude/orc-state/merge-summary.md", content: "")
```

#### Dispatch: Spawn merge coordinator
```
Task(
  description: "Merge implementations to root branch",
  subagent_type: "general-purpose",
  model: "opus",
  allowed_tools: ["Bash(git:*)", "Bash(git-wt:*)", "Bash(cd:*)", "Read", "Edit", "Write", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"],
  run_in_background: true,
  prompt: """
    You are the merge coordinator.

    Input:
    - Execution plan: [from .claude/orc-state/planning-output.yaml]
    - Implementation summaries: [paths to impl-chunk-N.md files]
    - Stack ID: [from execution plan]
    - Root branch: [from execution plan]
    - Base branch: [target for PR]

    Merge children to root sequentially per merge_order.
    Resolve conflicts inline. Clean up worktrees (keep root branch for PR).

    Write summary to .claude/orc-state/merge-summary.md
  """
) -> task_id: "merge-bg"
```

#### After: Collect and verify
```
TaskOutput(task_id: "merge-bg", block: true)
Read(file_path: ".claude/orc-state/merge-summary.md")
```

Merge coordinator: merges children to root sequentially, resolves conflicts, cleans up worktrees (keeps root branch for PR).

```
# Mark Phase 2 complete
TaskGet(taskId: "phase-2-id")
TaskUpdate(taskId: "phase-2-id", status: "completed")
```

</phase_2>

---

<phase_3 title="Review & Ship">

**Goal**: Quality validation and PR creation

```
# Mark Phase 3 as in_progress
TaskGet(taskId: "phase-3-id")
TaskUpdate(taskId: "phase-3-id", status: "in_progress")
```

### Step 1: Quality Review

#### Before: Pre-truncate output
```
Write(file_path: ".claude/orc-state/review-findings.json", content: "")
```

#### Dispatch: Spawn reviewer agent(s)
```
Task(
  description: "Review merged implementation",
  subagent_type: "general-purpose",
  allowed_tools: ["Read", "Grep", "Glob", "Write"],
  run_in_background: true,
  prompt: """
    You are a code reviewer. Focus: simplicity/DRY, bugs, code quality.

    Review: [root branch files]

    Write findings to .claude/orc-state/review-findings.json

    JSON format:
    {
      "high": [{"file": "...", "line": N, "issue": "..."}],
      "medium": [...],
      "low": [...]
    }
  """
) -> task_id: "review-bg"
```

#### After: Collect and verify
```
TaskOutput(task_id: "review-bg", block: true)
Read(file_path: ".claude/orc-state/review-findings.json")
```

### Step 2: Handle Findings

- HIGH severity → STOP, present to user, get direction
- MEDIUM/LOW → Report but proceed

```
# If HIGH severity issues found:
AskUserQuestion(questions: [{
  question: "HIGH severity issues found. How to proceed?",
  header: "Review",
  options: [
    {label: "Fix issues", description: "Address HIGH severity before PR"},
    {label: "Proceed anyway", description: "Create PR with known issues"},
    {label: "Abort", description: "Do not create PR"}
  ],
  multiSelect: false
}])
```

### Step 3: Create PR

```bash
gh pr create --head <root-branch> --base <base-branch> \
  --title "[type]: [description]" \
  --body "## Summary\n[What was built]\n\n## Changes\n[Key changes]\n\n## Test Plan\n[How to verify]"
```

### Step 4: Summary

```
# Mark Phase 3 complete
TaskGet(taskId: "phase-3-id")
TaskUpdate(taskId: "phase-3-id", status: "completed")
```

Present: what was built, key decisions, stack ID, chunks, files modified, PR URL, next steps.

</phase_3>

---

<important_notes>

### Git Worktree Stacks
Uses `git-wt --stack`: creates stack, returns JSON with paths/branches. Children merge to root, root PRs to base. Cleanup via `git-wt --stack-cleanup`.

### Git Hooks
Pre-commit/pre-push hooks handle linting, type checking, tests automatically.

### Subagent Communication
Subagents are stateless: separate task context, no follow-up messages, communicate only via output files. Use pre-truncate → dispatch → TaskOutput → verify pattern.

### State Directory
All subagent output goes to `.claude/orc-state/`. Pre-truncate files before dispatch, verify after return.

### Concurrency
Worktree stacks provide isolation. Agents work in separate directories under `<repo>.wt/`.

### When to Stop
Stop and inform user if: `git-wt` unavailable, blocking agent errors, unresolvable conflicts, scope creep, HIGH severity findings.

### Error Handling
If a subagent fails after 2 attempts:
1. `TaskStop(task_id: "bg-X")` to clean up stuck background task
2. `AskUserQuestion` with structured options (retry, skip, abort)

### Context Management

For long orchestrations approaching context limits:
1. Save progress to `.claude/orc-checkpoint.yaml` (phase, step, state)
2. Summarize completed work for potential continuation
3. Inform user: "Context limit approaching. State saved to .claude/orc-checkpoint.yaml" (TODO: /orc:resume coming soon)

Monitor context usage throughout. Prioritize completing current phase before checkpointing.

</important_notes>
