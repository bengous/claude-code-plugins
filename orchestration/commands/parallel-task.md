---
description: Execute bulk modifications across codebase with parallel agents and safety guarantees
argument-hint: <task-description>
allowed-tools:
  - Task
  - Glob
  - Grep
  - Read
  - Bash
  - Edit
  - Write
  - AskUserQuestion
---

<task>
$ARGUMENTS
</task>

<tools>
- **Task**: Spawn explore/worker agents
- **Glob/Grep/Read**: Codebase exploration
- **AskUserQuestion**: Get approval before execution
- **Bash**: Run verification commands, git operations
- **Edit/Write**: Only via worker agents, not directly
</tools>

<workflow>

## Phase 0: Planning & Analysis

1. Analyze the task and break into parallel work units
2. Identify target scopes (folders/files to modify)
3. Detect project verification commands:
   - Check `package.json` scripts (test, lint, typecheck, type-check)
   - Check for Makefile, pyproject.toml, Cargo.toml
   - Note available commands for Phase 4
4. Define safety requirements and verification criteria
5. **Present complete plan using AskUserQuestion for approval before execution**

## Phase 1: Exploration (Parallel)

Spawn N explore agents analyzing different areas.

**Spawn ALL explore agents in a SINGLE message using parallel Task tool calls:**

```
Task 1: subagent_type="Explore", model="sonnet", prompt="Analyze [scope1] for [task]. Report: files to change, patterns to follow, risks."
Task 2: subagent_type="Explore", model="sonnet", prompt="Analyze [scope2] for [task]. Report: files to change, patterns to follow, risks."
...
```

Use `model="haiku"` for gates or external exploration (web searches, MCP tools).

Collect reports, identify what to change vs preserve, estimate impact.

## Phase 2: Safety Setup

1. Create rollback point: `git checkout -b backup/parallel-task-$(date +%s)`
2. Add temporary files to .gitignore if needed
3. Confirm all safety nets in place

## Phase 3: Execution (Parallel)

Spawn N worker agents with strict scope isolation.

**Spawn ALL worker agents in a SINGLE message using parallel Task tool calls:**

```
Task 1: subagent_type="general-purpose", model="opus", prompt="[Detailed instructions for scope1]"
Task 2: subagent_type="general-purpose", model="opus", prompt="[Detailed instructions for scope2]"
...
```

Each agent prompt includes:
- Explicit folder assignment (modify ONLY files in this scope)
- Step-by-step commands (not goals)
- Verification requirements (run lint/type-check before committing)
- Error handling: if blocked, return error report instead of partial work
- Commit changes with descriptive message including scope name

Wait for ALL agents to complete. If any fail, stop and report to user.

## Phase 4: Validation

Run project's verification commands detected in Phase 0.

Also verify:
- No cross-scope contamination: `git diff --stat`
- All git hooks pass: run `git hook run pre-commit` or stage + unstage to trigger
- No regressions in functionality

## Phase 5: Final Report

Present:
- All commits created (with hashes)
- Total impact (files changed, lines added/removed)
- Items preserved vs removed
- Review commands: `git log --oneline -N`, `git diff HEAD~N`

</workflow>

<context_management>
For long orchestrations approaching context limits:
1. Complete current phase before any checkpointing
2. Save progress to a state file in the project (e.g., `.claude/orchestration-state.yaml`)
3. Inform user: "Context limit approaching. State saved to [path]."
</context_management>
