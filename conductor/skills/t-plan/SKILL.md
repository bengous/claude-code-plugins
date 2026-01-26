---
name: t-plan
description: Thorough planning for complex features using Task-based orchestration. Turn discussions into executable, self-contained implementation plans. USE for multi-file features, architectural changes, unfamiliar tech requiring research. SKIP for quick fixes or single-file changes.
---

# T-Plan Skill (Task-Based Orchestration)

## MANDATORY: STOP AND READ THIS FIRST

**You are an ORCHESTRATOR, not an implementer.**

Before doing ANYTHING else, you MUST:

1. **Create the session directory** with `mkdir -p .t-plan/<session-id>`
2. **Write intent.md** capturing the user's request
3. **Create the master task** with TaskCreate

**You MUST NOT:**
- Use Read, Grep, Glob, or WebSearch yourself (that's the EXPLORE subagent's job)
- Research documentation yourself (that's the VALIDATE subagent's job)
- Skip directly to analysis or recommendations

**If you find yourself exploring the codebase before writing intent.md, STOP. You have violated the workflow.**

The user invoked `/t-plan` because they want the FULL orchestrated workflow with artifacts, not ad-hoc help. Follow the steps below EXACTLY.

---

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

**Reference material** (load when needed):
- Retry logic & parallel execution: See `references/subagent-patterns.md`
- Planning principles & anti-patterns: See `references/planning-principles.md`
- Plan output template: See `references/plan-template.md`

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
    +-- validation-v001.json       # VALIDATE subagent writes
    +-- plan.md                    # Final output (Step 6)
```

**Session ID format:** `<slug>-<YYYYMMDD-HHMMSS>`

---

## Step 1: INTENT [ORCHESTRATOR]

**Goal**: Capture user intent and initialize session.

### Initialize Session

```
SESSION_ID="<slug>-<YYYYMMDD-HHMMSS>"
Bash: mkdir -p .t-plan/${SESSION_ID}
Write: .t-plan/.gitignore -> "*\n!.gitignore\n"
Write: .t-plan/current.txt -> "${SESSION_ID}"
TaskCreate(subject: "T-Plan: [goal]", metadata: {"session_id": "${SESSION_ID}"})
TaskGet + TaskUpdate(status: "in_progress")
```

### Capture Intent

1. Capture the user's request in their terms
2. Clarify ambiguities that would prevent focused exploration
3. Do NOT assume technologies or solutions
4. Write intent to `.t-plan/${SESSION_ID}/intent.md`

### Clarity Gate

> "Can I write a focused prompt for the EXPLORE subagent?"

- **NO** -> Clarify using AskUserQuestion with options: "Narrow scope", "Define outcome", "Add constraints"
- **YES** -> Proceed to EXPLORE

---

## Step 2: EXPLORE [SUBAGENT]

**Goal**: Understand the codebase relevant to the user's intent.

### Dispatch Pattern

```
# Pre-truncate output
Write: .t-plan/${SESSION_ID}/explore.md -> ""

# Create tracking task
TaskCreate(subject: "EXPLORE: [area]", metadata: {"output_file": "explore.md"})

# Dispatch
Task(subagent_type: "Explore", allowed_tools: ["Read", "Grep", "Glob", "Write"], prompt: """
  **Context**: Read .t-plan/${SESSION_ID}/intent.md

  **Task**: Explore codebase to understand:
  1. Tech stack, frameworks, patterns
  2. Existing code related to [area]
  3. Project structure and conventions
  4. Relevant installed dependencies

  **Output**: Write to .t-plan/${SESSION_ID}/explore.md
  - Start with summary referencing intent.md (proof-of-read)
  - Include key files with line references
  - Describe architecture connections
""")

# Verify: exists + non-empty + references intent.md
# Retry up to 2 attempts (see references/subagent-patterns.md)
```

### Complexity Gate

> "Is this task trivially simple?" (single file, pattern exists, no deps, no architecture)

**If trivially simple:** Ask user: "Continue T-Plan" / "Normal plan mode" / "Skip to DRAFT"

**If not trivially simple:** Continue to SCOUT or DRAFT.

---

## Step 3: SCOUT [SUBAGENT] (Optional)

**Goal**: Find alternatives that might be simpler than the obvious approach.

### Dispatch Pattern

```
# Pre-truncate + create task
Write: .t-plan/${SESSION_ID}/scout.md -> ""
TaskCreate(subject: "SCOUT: alternatives")

# Dispatch
Task(subagent_type: "general-purpose", allowed_tools: ["Read", "Grep", "Glob", "Write"], prompt: """
  **Context**: Read intent.md and explore.md

  **Task**: Search for alternatives MEANINGFULLY simpler:
  - Fewer dependencies
  - Less code to maintain
  - Better fits existing patterns

  DO NOT query documentation (that's VALIDATE's job).

  **Output**: Write to .t-plan/${SESSION_ID}/scout.md
  Often correct output is: "No simpler alternatives found."
""")

# Verify: exists + non-empty + references explore.md
```

---

## Step 4: DRAFT [ORCHESTRATOR]

**Goal**: Synthesize all context and draft an initial approach.

### What to Do

1. Read intent.md, explore.md, scout.md (if exists)
2. Read key implementation files identified by EXPLORE
3. Write draft to `.t-plan/${SESSION_ID}/draft-v001.md`

```markdown
## Approach

**Goal**: [1-2 sentences]

**Key decisions**:
- [Decision 1]: [Choice] because [rationale]. Rejected: [alternatives]

**Files to modify/create**:
- `path/to/file.ts` - [what changes]

**Approach outline**:
1. [High-level step 1]
2. [High-level step 2]
```

Update master task: `TaskUpdate(metadata: {"draft_version": 1})`

---

## Step 5: VALIDATE [SUBAGENT] (Required Checkpoint)

**Goal**: Check the draft approach against official documentation.

> **Note**: VALIDATE is required before PLAN. If skipping (internal refactor, no external APIs),
> record explicit rationale in the plan.

### Dispatch Pattern

```
# Pre-truncate
Write: .t-plan/${SESSION_ID}/validation-v001.json -> ""
TaskCreate(subject: "VALIDATE: draft v1")

# Dispatch
Task(subagent_type: "general-purpose",
     allowed_tools: ["Read", "Grep", "Glob", "Write", "WebSearch", "WebFetch"],
     prompt: """
  **Context**: Read intent.md, explore.md, scout.md (if exists), draft-v001.md

  **Task**: Validate draft against official documentation.
  - Using RECOMMENDED patterns?
  - Any DEPRECATED APIs or anti-patterns?
  - What are the GOTCHAS?
  - Provide WORKING setup snippets

  **Output**: Write to .t-plan/${SESSION_ID}/validation-v001.json
  {
    "draft_version": 1,
    "status": "VALID" | "NEEDS_CHANGES",
    "confirmations": [...],
    "corrections": [...],
    "snippets": [...],
    "gotchas": [...],
    "doc_links": [...]
  }
""")

# Verify: valid JSON + draft_version matches + status exists
```

### Validation Loop

If `status: "NEEDS_CHANGES"`:
1. Revise draft -> `draft-v002.md`
2. Update metadata: `{"draft_version": 2}`
3. Re-run VALIDATE with v002
4. Repeat until `status: "VALID"`

---

## Step 6: PLAN [ORCHESTRATOR + USER]

**Goal**: Present final plan for user approval.

### What to Do

1. Incorporate VALIDATE feedback into final approach
2. Enter plan mode: `EnterPlanMode()`
3. Write `.t-plan/${SESSION_ID}/plan.md` following `references/plan-template.md`
4. Present to user, iterate until approved

```
EnterPlanMode()
Read all context files
Write plan following template
TaskUpdate(status: "completed")
```

### On Approval

Present next steps via AskUserQuestion:
- **Execute now**: Exit plan mode, begin implementation
- **Spawn agent**: Create Task with plan.md as context
- **Save for later**: Report plan location, session complete

---

## Quick Reference

| Step | Actor | Task Subject | Output |
|------|-------|--------------|--------|
| INTENT | Orchestrator | "T-Plan: [goal]" | intent.md |
| EXPLORE | Subagent | "EXPLORE: [area]" | explore.md |
| SCOUT | Subagent | "SCOUT: alternatives" | scout.md |
| DRAFT | Orchestrator | (metadata update) | draft-vNNN.md |
| VALIDATE | Subagent | "VALIDATE: v{N}" | validation-vNNN.json |
| PLAN | Orch + User | (task complete) | plan.md |

For retry logic and parallel execution patterns, see `references/subagent-patterns.md`.
For planning quality principles and anti-patterns, see `references/planning-principles.md`.

---

## Resume from Artifacts

If session is interrupted and task list is unavailable:

```
# Find latest session
Read: .t-plan/current.txt -> auth-oauth-20260124-150230

# Check what artifacts exist
Glob: .t-plan/auth-oauth-20260124-150230/*

# Resume from last completed phase:
# - Has intent.md only -> resume at EXPLORE
# - Has explore.md -> resume at complexity gate
# - Has draft-vNNN.md -> resume at VALIDATE
# - Has validation-vNNN.json with VALID -> resume at PLAN
```
