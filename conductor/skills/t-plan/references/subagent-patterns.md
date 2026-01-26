# Subagent Patterns Reference

Load this file when implementing retry logic or parallel execution.

## Table of Contents

1. [Verification Rules](#verification-rules)
2. [Retry Logic](#retry-logic)
3. [Parallel Execution Pattern](#parallel-execution-pattern)

---

## Verification Rules

| Phase | Output | Verification |
|-------|--------|--------------|
| EXPLORE | explore.md | exists + non-empty + references intent.md |
| SCOUT | scout.md | exists + non-empty + references explore.md |
| VALIDATE | validation-vNNN.json | valid JSON + draft_version matches + status field exists |

---

## Retry Logic

```
MAX_ATTEMPTS = 2

for attempt in 1..MAX_ATTEMPTS:
  # Pre-truncate
  Write(file_path: output_file, content: "")

  # Dispatch subagent and capture task_id for potential cleanup
  result = Task(description: "...", subagent_type: "...", prompt: "...", run_in_background: true)
  bg_task_id = result.task_id
  TaskOutput(task_id: bg_task_id, block: true)

  # Verify
  content = Read(file_path: output_file)
  if valid(content):
    TaskGet(taskId: "tracking-task-id")
    TaskUpdate(taskId: "tracking-task-id", status: "completed")
    break
  elif attempt == MAX_ATTEMPTS:
    # Stop any stuck background task before escalating
    TaskStop(task_id: bg_task_id)

    # Escalate with structured options
    AskUserQuestion(questions: [{
      question: "Subagent failed after 2 attempts. Last output: [preview]. How to proceed?",
      header: "Retry Failed",
      options: [
        {label: "Manual fix", description: "I'll write the output file myself"},
        {label: "Skip phase", description: "Continue without this phase's output"},
        {label: "Abort", description: "Stop T-Plan session"}
      ],
      multiSelect: false
    }])
```

---

## Parallel Execution Pattern

When tasks have no dependencies, spawn multiple subagents simultaneously:

```
# Pre-truncate all output files
Write(file_path: ".t-plan/${SESSION_ID}/explore-auth.md", content: "")
Write(file_path: ".t-plan/${SESSION_ID}/explore-db.md", content: "")
Write(file_path: ".t-plan/${SESSION_ID}/explore-api.md", content: "")

# Create tracking tasks
TaskCreate(subject: "EXPLORE: auth module", description: "...", metadata: {"output_file": "explore-auth.md"})
TaskCreate(subject: "EXPLORE: database layer", description: "...", metadata: {"output_file": "explore-db.md"})
TaskCreate(subject: "EXPLORE: API endpoints", description: "...", metadata: {"output_file": "explore-api.md"})

# Spawn all three Explore agents in parallel with run_in_background
Task(
  description: "Explore auth module",
  subagent_type: "Explore",
  allowed_tools: ["Read", "Grep", "Glob", "Write"],
  prompt: "Write to explore-auth.md...",
  run_in_background: true
) -> returns task_id: "bg-1"

Task(
  description: "Explore database layer",
  subagent_type: "Explore",
  allowed_tools: ["Read", "Grep", "Glob", "Write"],
  prompt: "Write to explore-db.md...",
  run_in_background: true
) -> returns task_id: "bg-2"

Task(
  description: "Explore API endpoints",
  subagent_type: "Explore",
  allowed_tools: ["Read", "Grep", "Glob", "Write"],
  prompt: "Write to explore-api.md...",
  run_in_background: true
) -> returns task_id: "bg-3"

# Collect results using TaskOutput (blocks until each completes)
TaskOutput(task_id: "bg-1", block: true)
TaskOutput(task_id: "bg-2", block: true)
TaskOutput(task_id: "bg-3", block: true)

# If any task failed or timed out, clean up before proceeding:
# TaskStop(task_id: "bg-X") for any incomplete background tasks

# Verify each output file
Read(file_path: ".t-plan/${SESSION_ID}/explore-auth.md")
Read(file_path: ".t-plan/${SESSION_ID}/explore-db.md")
Read(file_path: ".t-plan/${SESSION_ID}/explore-api.md")

# Mark tracking tasks complete after verification (read state before each update)
TaskGet(taskId: "auth-task-id")
TaskUpdate(taskId: "auth-task-id", status: "completed")
TaskGet(taskId: "db-task-id")
TaskUpdate(taskId: "db-task-id", status: "completed")
TaskGet(taskId: "api-task-id")
TaskUpdate(taskId: "api-task-id", status: "completed")

# Synthesize into unified explore.md
Write(file_path: ".t-plan/${SESSION_ID}/explore.md", content: "[synthesized findings]")
```
