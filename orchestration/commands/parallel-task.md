---
description: Execute bulk modifications across codebase with parallel agents and safety guarantees
argument-hint: <task-description>
allowed-tools:
  - Agent
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

Leave code changes to the worker agents: this command plans, sets up, dispatches and verifies.

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

Spawn every explore agent in one message, so they run concurrently:

```
Agent 1: subagent_type="Explore", model="sonnet", prompt="Analyze [scope1] for [task]. Report: files to change, patterns to follow, risks."
Agent 2: subagent_type="Explore", model="sonnet", prompt="Analyze [scope2] for [task]. Report: files to change, patterns to follow, risks."
...
```

`sonnet` is the floor for exploration work; do not route these to a cheaper tier.

Collect reports, identify what to change vs preserve, estimate impact.

## Phase 2: Safety Setup

1. Create rollback point, staying on the current branch: `git branch backup/parallel-task-$(date +%s)`
2. Add temporary files to .gitignore if needed
3. Confirm all safety nets in place

## Phase 3: Execution (Parallel)

Spawn N worker agents with strict scope isolation.

Spawn every worker agent in one message, so they run concurrently:

```
Agent 1: subagent_type="general-purpose", model="opus", prompt="[Detailed instructions for scope1]"
Agent 2: subagent_type="general-purpose", model="opus", prompt="[Detailed instructions for scope2]"
...
```

Each agent prompt includes:
- Explicit folder assignment (modify ONLY files in this scope)
- The change to make, stated as its outcome, with exact commands only where a single sequence is safe
- Verification requirements (run lint/type-check before committing)
- Error handling: if blocked, return error report instead of partial work
- Commit changes with descriptive message including scope name

Wait for ALL agents to complete. If any fail, stop and report to user.

## Phase 4: Validation

Run project's verification commands detected in Phase 0.

Also verify:
- No cross-scope contamination: `git diff --stat backup/parallel-task-<timestamp>..HEAD`, each file inside the scope of the worker that committed it
- No regressions in functionality

## Phase 5: Final Report

Present:
- All commits created (with hashes)
- Total impact (files changed, lines added/removed)
- Items preserved vs removed
- Review commands: `git log --oneline -N`, `git diff HEAD~N`

</workflow>
