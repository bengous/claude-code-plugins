---
name: t-plan
description: Thorough planning for complex features using Task-based orchestration. Turn discussions into executable, self-contained implementation plans. USE for multi-file features, architectural changes, unfamiliar tech requiring research. SKIP for quick fixes or single-file changes.
---

# T-Plan Skill (Task-Based Orchestration)

Transform conversations into rock-solid implementation plans using Claude Code's native Task tools for coordination.

## Architecture Overview

```
No hooks required - Task tools handle all coordination natively.

Orchestrator responsibilities:
- Session initialization (mkdir, .gitignore, current.txt pointer)
- Task lifecycle (TaskCreate, TaskUpdate)
- Pre-truncation before subagent dispatch
- Output verification after subagent return
- Retry logic (max 2 attempts)

Subagent responsibilities:
- Read context files (intent.md, explore.md, etc.)
- Write output files directly (explore.md, scout.md, validation-vNNN.json)
- Focus on their assigned task
```

---

## Workflow

```
INTENT -> EXPLORE -> [gate] -> SCOUT -> DRAFT -> VALIDATE -> PLAN
   |          |                   |        |          |         |
 orch.     subagent            subagent  orch.    subagent   orch.+user
```

| Step | Actor | Output |
|------|-------|--------|
| **INTENT** | Orchestrator | Clear intent (gate: can direct EXPLORE?) |
| **EXPLORE** | Subagent | Codebase insights (gate: trivial -> skip?) |
| **SCOUT** | Subagent (optional) | Alternatives only (no docs) |
| **DRAFT** | Orchestrator | Initial approach (reads files, synthesizes) |
| **VALIDATE** | Subagent (required checkpoint) | Doc validation + snippets |
| **PLAN** | Orchestrator + User | Final plan, iterate until approved |

**Principles:**
- Subagents gather information
- Orchestrator synthesizes and decides
- Two gates: clarity (INTENT), complexity (EXPLORE)
- Single user checkpoint (PLAN)

---

## Session Directory Structure

```
.t-plan/
+-- current.txt                    # Text pointer: "auth-oauth-20260124-150230"
+-- .gitignore                     # Ignore all session dirs
+-- auth-oauth-20260124-150230/    # Session directory
    +-- intent.md                  # Orchestrator writes (Step 1)
    +-- explore.md                 # EXPLORE subagent writes
    +-- scout.md                   # SCOUT subagent writes (optional)
    +-- draft-v001.md              # Orchestrator writes (Step 4)
    +-- draft-v002.md              # Revised if needed
    +-- validation-v001.json       # VALIDATE subagent writes (optional)
    +-- validation-v002.json       # Revised if needed
    +-- plan.md                    # Final output (Step 6)
```

**Session ID format:** `<slug>-<YYYYMMDD-HHMMSS>`
- Example: `auth-oauth-20260124-150230`
- If collision, append `-2`, `-3`, etc.

---

## Step 1: INTENT [ORCHESTRATOR]

**Goal**: Capture user intent and initialize session.

### Initialize Session

```
# Create session directory
SESSION_ID="<slug>-<YYYYMMDD-HHMMSS>"
Bash(command: "mkdir -p .t-plan/${SESSION_ID}")

# Create .gitignore if not exists
Write(file_path: ".t-plan/.gitignore", content: "*\n!.gitignore\n")

# Create current.txt pointer
Write(file_path: ".t-plan/current.txt", content: "${SESSION_ID}")

# Create master task
TaskCreate(
  subject: "T-Plan: [brief goal description]",
  description: "Thorough planning workflow for: [user's request]",
  activeForm: "Planning implementation",
  metadata: {"session_id": "${SESSION_ID}", "phase": "INTENT"}
)
TaskUpdate(taskId: "master-id", status: "in_progress")
```

### Capture Intent

1. Capture the user's request in their terms
2. Clarify ambiguities that would prevent focused exploration
3. Do NOT assume technologies or solutions
4. Write intent to `.t-plan/${SESSION_ID}/intent.md`

```
Write(file_path: ".t-plan/${SESSION_ID}/intent.md", content: "...")
```

### Clarity Gate

> "Can I write a focused prompt for the EXPLORE subagent?"

- **NO** -> Clarify with user, loop until yes
- **YES** -> Proceed to EXPLORE

---

## Step 2: EXPLORE [SUBAGENT]

**Goal**: Understand the codebase relevant to the user's intent.

### Before: Pre-truncate Output

```
# Ensure clean slate for subagent output
Write(file_path: ".t-plan/${SESSION_ID}/explore.md", content: "")

# Create task for tracking
TaskCreate(
  subject: "EXPLORE: [specific area from intent]",
  description: "Explore codebase to understand architecture and patterns",
  activeForm: "Exploring codebase",
  metadata: {"phase": "EXPLORE", "output_file": "explore.md"}
)
```

### Dispatch Subagent

```
Task(
  description: "Explore codebase for [specific area]",
  subagent_type: "Explore",
  allowed_tools: ["Read", "Grep", "Glob", "Write"],
  prompt: """
    **Context**: Read .t-plan/${SESSION_ID}/intent.md

    **Your task**: Explore the codebase to understand:
    1. Tech stack, frameworks, patterns in use
    2. Existing code related to [specific area from intent]
    3. Project structure and conventions
    4. Installed dependencies relevant to this task

    **Output**: Write findings to .t-plan/${SESSION_ID}/explore.md

    Your output MUST:
    - Start with 1-2 line summary referencing intent.md (proof-of-read)
    - Include key files with line references, not just paths
    - Describe architecture: how components connect
    - List relevant installed dependencies
  """
)
```

### After: Verify Output

```
# Read and verify output
Read(file_path: ".t-plan/${SESSION_ID}/explore.md")

# Verify structure
Check:
- File exists and is non-empty
- Contains proof-of-read (references intent.md content)
- Has substance (key files, architecture, dependencies)

# If invalid and attempts < 2:
#   Re-dispatch with clearer prompt
# If valid:
TaskUpdate(taskId: "explore-task-id", status: "completed")
```

### Complexity Gate

> "Is this task trivially simple?"

Trivially simple means ALL of:
- Single file change
- Pattern already exists in codebase
- No external dependencies
- No architectural decisions

**If trivially simple:** Offer to switch to normal plan mode.
**If not trivially simple:** Continue to SCOUT or DRAFT.

---

## Step 3: SCOUT [SUBAGENT] (Optional)

**Goal**: Find alternatives that might be simpler than the obvious approach.

### Before: Pre-truncate Output

```
Write(file_path: ".t-plan/${SESSION_ID}/scout.md", content: "")

TaskCreate(
  subject: "SCOUT: Find simpler alternatives",
  description: "Search for alternatives to the obvious approach",
  activeForm: "Scouting alternatives",
  metadata: {"phase": "SCOUT", "output_file": "scout.md"}
)
```

### Dispatch Subagent

```
Task(
  description: "Scout for simpler alternatives",
  subagent_type: "general-purpose",
  allowed_tools: ["Read", "Grep", "Glob", "Write"],
  prompt: """
    **Context**:
    - Read .t-plan/${SESSION_ID}/intent.md
    - Read .t-plan/${SESSION_ID}/explore.md

    **Your task**: Search for alternatives to the obvious approach.

    Only report alternatives that are MEANINGFULLY simpler:
    - Fewer dependencies
    - Less code to write/maintain
    - Better fits existing patterns
    - More mature/stable solution

    DO NOT query documentation (that's VALIDATE's job).

    **Output**: Write to .t-plan/${SESSION_ID}/scout.md

    Often the correct output is: "No simpler alternatives found. Proceed with [approach]."
  """
)
```

### After: Verify Output

```
Read(file_path: ".t-plan/${SESSION_ID}/scout.md")

Check:
- File exists and is non-empty
- References explore.md findings (proof-of-read)

# Retry if invalid (max 2 attempts)
# Mark complete when valid
TaskUpdate(taskId: "scout-task-id", status: "completed")
```

---

## Step 4: DRAFT [ORCHESTRATOR]

**Goal**: Synthesize all context and draft an initial approach.

### What to Do

1. Read key files identified by EXPLORE/SCOUT
2. Synthesize intent + codebase insights + alternatives
3. Write draft to `.t-plan/${SESSION_ID}/draft-v001.md`

```
# Read context
Read(file_path: ".t-plan/${SESSION_ID}/intent.md")
Read(file_path: ".t-plan/${SESSION_ID}/explore.md")

# Check if scout.md exists before reading
Glob(pattern: ".t-plan/${SESSION_ID}/scout.md")
# If found:
Read(file_path: ".t-plan/${SESSION_ID}/scout.md")

# Read key implementation files as needed
Read(file_path: "[key files identified by EXPLORE]")

# Write draft
Write(file_path: ".t-plan/${SESSION_ID}/draft-v001.md", content: """
## Approach

**Goal**: [1-2 sentences]

**Key decisions**:
- [Decision 1]: [Choice] because [rationale]. Rejected: [alternatives]

**Files to modify/create**:
- `path/to/file.ts` - [what changes]

**Approach outline**:
1. [High-level step 1]
2. [High-level step 2]
""")

# Update master task metadata
TaskUpdate(
  taskId: "master-id",
  metadata: {"draft_version": 1}
)
```

---

## Step 5: VALIDATE [SUBAGENT] (Required Checkpoint)

**Goal**: Check the draft approach against official documentation.

> **Note**: VALIDATE is required before PLAN. If skipping (e.g., internal refactor with no external APIs),
> record explicit rationale: `"validation": "N/A - internal refactor, no new APIs"` in the plan.

### Before: Pre-truncate Output

```
Write(file_path: ".t-plan/${SESSION_ID}/validation-v001.json", content: "")

TaskCreate(
  subject: "VALIDATE: Check draft v1 against docs",
  description: "Validate draft approach against official documentation",
  activeForm: "Validating approach",
  metadata: {"phase": "VALIDATE", "draft_version": 1}
)
```

### Dispatch Subagent

```
Task(
  description: "Validate draft v1 against official docs",
  subagent_type: "general-purpose",
  allowed_tools: ["Read", "Grep", "Glob", "Write", "WebSearch", "WebFetch"],
  prompt: """
    **Context**:
    - Read .t-plan/${SESSION_ID}/intent.md
    - Read .t-plan/${SESSION_ID}/explore.md
    - Check if .t-plan/${SESSION_ID}/scout.md exists, read if present
    - Read .t-plan/${SESSION_ID}/draft-v001.md

    **Your task**: Validate the draft approach against official documentation.

    Check:
    - Using RECOMMENDED patterns?
    - Any DEPRECATED APIs or anti-patterns?
    - What are the GOTCHAS or common mistakes?
    - Provide WORKING setup snippets (not pseudocode)

    **Output**: Write to .t-plan/${SESSION_ID}/validation-v001.json

    JSON format:
    {
      "draft_version": 1,
      "status": "VALID" | "NEEDS_CHANGES",
      "confirmations": ["..."],
      "corrections": ["..."],
      "snippets": ["..."],
      "gotchas": ["..."],
      "doc_links": ["..."]
    }
  """
)
```

### After: Verify Output

```
Read(file_path: ".t-plan/${SESSION_ID}/validation-v001.json")

Check:
- File is valid JSON
- Contains draft_version field matching expected version
- Contains status field ("VALID" or "NEEDS_CHANGES")

# Retry if invalid (max 2 attempts)
TaskUpdate(taskId: "validate-task-id", status: "completed")
```

### Validation Loop

If `status: "NEEDS_CHANGES"`:
1. Revise draft -> `draft-v002.md`
2. Update metadata: `TaskUpdate(taskId: "master-id", metadata: {"draft_version": 2})`
3. Pre-truncate: `Write(file_path: ".t-plan/${SESSION_ID}/validation-v002.json", content: "")`
4. Create new VALIDATE task for v002
5. Repeat until `status: "VALID"`

---

## Step 6: PLAN [ORCHESTRATOR + USER]

**Goal**: Present final plan for user approval.

### What to Do

1. Incorporate VALIDATE feedback into final approach
2. Enter plan mode: `EnterPlanMode()`
3. Write `.t-plan/${SESSION_ID}/plan.md` following template in `references/plan-template.md`
4. Present to user, iterate until approved

```
# Enter plan mode for structured planning
EnterPlanMode()

# Read all context
Read(file_path: ".t-plan/${SESSION_ID}/intent.md")
Read(file_path: ".t-plan/${SESSION_ID}/explore.md")
Read(file_path: ".t-plan/${SESSION_ID}/draft-vNNN.md")
Read(file_path: ".t-plan/${SESSION_ID}/validation-vNNN.json")

# Write plan following template
Write(file_path: ".t-plan/${SESSION_ID}/plan.md", content: "...")

# Mark master task complete
TaskUpdate(taskId: "master-id", status: "completed")
```

### On Approval

```
Plan written to: .t-plan/${SESSION_ID}/plan.md

How would you like to proceed?

1. **Execute now** - I'll implement this plan in this session
2. **Spawn agent** - I'll spawn a Task agent to implement the plan
3. **Save for later** - Plan is saved; start a fresh session when ready
```

---

## Verification Rules

| Phase | Output | Verification |
|-------|--------|--------------|
| EXPLORE | explore.md | exists + non-empty + references intent.md |
| SCOUT | scout.md | exists + non-empty + references explore.md |
| VALIDATE | validation-vNNN.json | valid JSON + draft_version matches + status field exists |

### Retry Logic

```
MAX_ATTEMPTS = 2

for attempt in 1..MAX_ATTEMPTS:
  # Pre-truncate
  Write(file_path: output_file, content: "")

  # Dispatch subagent (must include description parameter)
  Task(description: "...", subagent_type: "...", prompt: "...")

  # Verify
  content = Read(file_path: output_file)
  if valid(content):
    TaskUpdate(taskId: "task-id", status: "completed")
    break
  elif attempt == MAX_ATTEMPTS:
    # Escalate to user
    "Subagent failed to produce valid output after 2 attempts.
     Last output: [content preview]
     How would you like to proceed?"
```

---

## Quick Reference

| Step | Actor | Task Subject Pattern | Output |
|------|-------|---------------------|--------|
| INTENT | Orchestrator | "T-Plan: [goal]" (master) | intent.md |
| EXPLORE | Subagent | "EXPLORE: [area]" | explore.md |
| -- | Orchestrator | (complexity gate) | -- |
| SCOUT | Subagent | "SCOUT: alternatives" | scout.md |
| DRAFT | Orchestrator | (metadata update) | draft-vNNN.md |
| VALIDATE | Subagent | "VALIDATE: v{N}" | validation-vNNN.json |
| PLAN | Orch + User | (task complete) | plan.md |

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

# Verify each output file
Read(file_path: ".t-plan/${SESSION_ID}/explore-auth.md")
Read(file_path: ".t-plan/${SESSION_ID}/explore-db.md")
Read(file_path: ".t-plan/${SESSION_ID}/explore-api.md")

# Mark tracking tasks complete after verification
TaskUpdate(taskId: "auth-task-id", status: "completed")
TaskUpdate(taskId: "db-task-id", status: "completed")
TaskUpdate(taskId: "api-task-id", status: "completed")

# Synthesize into unified explore.md
Write(file_path: ".t-plan/${SESSION_ID}/explore.md", content: "[synthesized findings]")
```

---

## Resume from Artifacts

If session is interrupted and task list is unavailable, resume from artifacts:

```
# Find latest session
Read(file_path: ".t-plan/current.txt")  # -> auth-oauth-20260124-150230

# Check what artifacts exist
Glob(pattern: ".t-plan/auth-oauth-20260124-150230/*")

# Resume from last completed phase:
# - Has intent.md only -> resume at EXPLORE
# - Has explore.md -> resume at complexity gate
# - Has draft-vNNN.md -> resume at VALIDATE
# - Has validation-vNNN.json with VALID -> resume at PLAN
```

---

<design_decisions>
## Questions That Force Decisions

Before exploring solutions, force these choices:

**Scope decisions**
- "What's the simplest version that still delivers value?" -> Forces MVP boundary
- "If you could only ship one capability, which?" -> Forces prioritization

**Quality decisions**
- "What would make this a failure even if it 'works'?" -> Forces success criteria beyond "it runs"
- "Who's the handoff audience: you tomorrow, a teammate, or a future AI agent?" -> Forces documentation depth

**Build vs integrate decisions**
- "Is this core to your product or commodity infrastructure?" -> Forces build-vs-buy stance
- "What existing pattern in the codebase is this most similar to?" -> Forces reuse consideration
</design_decisions>

<planning_anti_patterns>
## Patterns to Avoid

Plans fail when implementers are left guessing. Avoid these patterns:

**Vague action items**
- "Implement the feature" -> Instead: "Create `src/services/feature.ts` with `handleX()` function following pattern in `src/services/auth.ts:45-60`"

**Assumed context**
- "Use the standard approach" -> Instead: Name the file containing the pattern and line numbers

**Pseudocode in research notes**
- `// handle the thing here` -> Instead: Working code snippets from docs that compile

**Missing decision rationale**
- "We chose Zustand" -> Instead: "We chose Zustand because [reason]. Rejected Redux (overkill), Context (scaling issues)"

**No failure guidance**
- Assumes happy path only -> Instead: Include "If X fails, check Y" for likely failure points

**Scope creep**
- "Could also add X later" mixed with core items -> Instead: Explicit "Out of scope" section
</planning_anti_patterns>

<planning_success_criteria>
## Success Criteria

A plan is "done right" when:

1. **Zero-context executable**: An implementer with only PLAN.md can complete the work without asking "what did you mean by X?"

2. **Decisions are justified**: Every key choice includes rationale AND rejected alternatives.

3. **Research is actionable**: Code snippets compile and run. Gotchas are specific.

4. **Checklist is granular**: 20-100 items, each a single focused unit of work, each naming specific files.

5. **Verification is observable**: Each phase ends with concrete checks: "tests pass", "endpoint returns 200", not "it works."

6. **Failure paths documented**: The 2-3 most likely failure points include "If X fails, check Y" guidance.

7. **Scope is bounded**: Explicit "out of scope" list prevents over-reach.
</planning_success_criteria>
