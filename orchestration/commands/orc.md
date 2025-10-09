---
description: Plan then route a task into SIMPLE/MEDIUM/COMPLEX execution paths
argument-hint: <task_description> [--base <branch>] [--confirm] [--force-path simple|medium|complex]
---

You are orchestrating a software development task. Follow these steps:

## PHASE 1: PLAN MODE - Task Classification

@.claude-plugin/commands/orc/_/concurrency

@.claude-plugin/commands/orc/_/flags

@.claude-plugin/commands/orc/_/classification

@.claude-plugin/commands/orc/_/run-state

**Task to classify:** $ARGUMENTS

If `--force-path` is provided, skip classification and use the specified path. Otherwise, analyze the task and classify it according to the criteria above.

After classification, present your decision with:
- Path chosen (SIMPLE/MEDIUM/COMPLEX)
- Rationale (2-3 bullets explaining why)
- Execution approach (brief strategy)

### State Initialization

Write initial state: `echo '{"type":"<SIMPLE|MEDIUM|COMPLEX>","base":null}' > .claude/run/current.json`

Generate run-id: `RUN_ID=$(date +%Y-%m-%d-%H%M%S)`

**If `--confirm` flag is present:**

Follow `.claude-plugin/commands/orc/_/approval`.

**If `--confirm` flag is NOT present (default):**

Write per-run state with status="planning" and proceed immediately to Phase 2.

---

## PHASE 2: EXECUTION - Route and Execute

Once approved (or if no approval required), execute according to the chosen path.

First, read `.claude-plugin/commands/orc/_/locks`.

### Path A: SIMPLE

Follow `.claude-plugin/commands/orc/_/simple-path`.

### Path B: MEDIUM

Follow `.claude-plugin/commands/orc/_/medium-path`.

### Path C: COMPLEX

Follow `.claude-plugin/commands/orc/_/complex-path`.

---

@.claude-plugin/commands/orc/_/constraints
