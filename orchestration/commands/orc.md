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

> **Dependency**: Requires `git-wt` on the `PATH`, the standalone script of the archived `git-worktree` plugin, copied from a clone of `bengous/claude-code-plugins` with `mkdir -p ~/.local/bin` then `install -m 755 archive/git-worktree/scripts/git-wt ~/.local/bin/git-wt`.
</principles>

---

<phase_1 title="Understand & Plan">

**Goal**: Gather context, get architect consensus, and get approval

Initial request: $ARGUMENTS

### Step 1: Track the Phases

Track the three phases as tasks (TaskCreate, TaskUpdate) so the user can follow progress.

### Step 2: Inline Exploration

Explore the codebase directly until you can summarize the relevant code, the patterns and conventions to follow, the integration points, and the files to change.

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

Issue all three `Agent` calls in ONE message — that is what makes them run concurrently.

```
Agent(
  description: "Architect: Minimal changes",
  subagent_type: "claude-orchestration:architect",
  prompt: """
    You are the MINIMAL architect. Focus: smallest diff, maximum code reuse, least disruption.

    Context: [Feature description, codebase findings, chunk breakdown, constraints]

    Write your architecture proposal to .claude/orc-state/architect-minimal.md

    Include: approach overview, file changes per chunk, key decisions with rationale
  """
)

Agent(
  description: "Architect: Clean architecture",
  subagent_type: "claude-orchestration:architect",
  prompt: """
    You are the CLEAN architect. Focus: maintainability, clear abstractions, long-term health.

    Context: [Feature description, codebase findings, chunk breakdown, constraints]

    Write your architecture proposal to .claude/orc-state/architect-clean.md

    Include: approach overview, file changes per chunk, key decisions with rationale
  """
)

Agent(
  description: "Architect: Pragmatic balance",
  subagent_type: "claude-orchestration:architect",
  prompt: """
    You are the PRAGMATIC architect. Focus: practical trade-offs, ship-ready approach.

    Context: [Feature description, codebase findings, chunk breakdown, constraints]

    Write your architecture proposal to .claude/orc-state/architect-pragmatic.md

    Include: approach overview, file changes per chunk, key decisions with rationale
  """
)
```

#### After: Collect results and verify

All three calls return before this step runs.

```
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

</phase_1>

---

<phase_2 title="Execute">

**Goal**: Implement in parallel using git worktrees

Delegate to subagents - orchestrate, don't implement.

### Step 1: Planning

#### Before: Pre-truncate output
```
Write(file_path: ".claude/orc-state/planning-output.yaml", content: "")
```

#### Dispatch: Spawn planning coordinator
```
Agent(
  description: "Create worktree stack and execution plan",
  subagent_type: "claude-orchestration:planning-coordinator",
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
)
```

#### After: Collect and verify
```
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
Agent(
  description: "Implement Chunk 1: [name]",
  subagent_type: "general-purpose",
  prompt: """
    You are an implementation agent for Chunk 1.

    Worktree path: [from execution plan]
    Branch: [from execution plan]
    Chunk description: [what to implement]
    Architecture guidance: [from consensus]
    Key files: [from chunk definition]

    Implement assigned chunk only. Stay in scope.
    Touch only files under your assigned worktree path.

    Write summary to .claude/orc-state/impl-chunk-1.md
    Include: files changed, implementation summary, notes for merge coordinator
  """
)

Agent(
  description: "Implement Chunk 2: [name]",
  subagent_type: "general-purpose",
  # ... same pattern
)

# ... for each chunk — all in ONE message
```

#### After: Collect ALL results
```
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
Agent(
  description: "Merge implementations to root branch",
  subagent_type: "claude-orchestration:merge-coordinator",
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
)
```

#### After: Collect and verify
```
Read(file_path: ".claude/orc-state/merge-summary.md")
```

Merge coordinator: merges children to root sequentially, resolves conflicts, cleans up worktrees (keeps root branch for PR).

</phase_2>

---

<phase_3 title="Review & Ship">

**Goal**: Quality validation and PR creation

### Step 1: Quality Review

#### Before: Pre-truncate output
```
Write(file_path: ".claude/orc-state/review-findings.json", content: "")
```

#### Dispatch: Spawn reviewer agent(s)
```
Agent(
  description: "Review merged implementation",
  subagent_type: "general-purpose",
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
)
```

#### After: Collect and verify
```
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

Present: what was built, key decisions, stack ID, chunks, files modified, PR URL, next steps.

</phase_3>

---

<important_notes>

### Git Worktree Stacks
Uses `git-wt --stack`: creates stack, returns JSON with paths/branches. Children merge to root, root PRs to base. Cleanup via `git-wt --stack-cleanup`.

### Git Hooks
Pre-commit/pre-push hooks handle linting, type checking, tests automatically.

### Subagent Communication
Subagents start without this conversation: their prompt carries everything they need, and their output file is the result this command reads. Use pre-truncate → dispatch → verify pattern. Spawn with `Agent`; issue concurrent calls in a single message. Tool restrictions and models live in the agent definitions under `agents/`.

### State Directory
All subagent output goes to `.claude/orc-state/`. Pre-truncate files before dispatch, verify after return.

### Concurrency
Worktree stacks provide isolation. Agents work in separate directories under `<repo>.wt/`.

### When to Stop
Stop and inform user if: `git-wt` unavailable, blocking agent errors, unresolvable conflicts, scope creep, HIGH severity findings.

### Error Handling
If a subagent fails after 2 attempts, escalate with `AskUserQuestion` using structured
options (retry, skip, abort). A failed `Agent` call returns without producing its output
file; the verify step detects it.

</important_notes>
