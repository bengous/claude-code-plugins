---
name: structured-plan
description: >
  Rigorous planning workflow with research validation, task breakdown,
  dependency mapping, and post-implementation verification. Use when:
  (1) planning complex features touching 5+ files, (2) architectural
  changes or major refactors, (3) unfamiliar tech requiring doc research,
  (4) user says "thorough plan", "rigorous plan", or "structured plan".
  Invoke with /structured-plan before or during plan mode.
---

# Structured Plan

A checklist-driven planning workflow that ensures plans are research-validated, broken into atomic tasks, complete, and self-verifying.

## Workflow Overview

```
Phase A: Clarification (if needed)
    ↓
Phase B: Iterative Refinement (7 steps)
    ↓
Exit Plan Mode → Implementation
```

---

## Phase A: Clarification

If the user's prompt is vague or ambiguous, use **AskUserQuestion** to clarify before proceeding. Ask about:
- Scope boundaries (what's in/out)
- Technology choices (if multiple options exist)
- Acceptance criteria (how to know it's done)

Once intent is clear, proceed to Phase B.

---

## Phase B: Iterative Refinement

After drafting an initial plan, apply this checklist. **Edit the plan file after each step** (not one-shot).

### Step 1: Research Validation

Validate your approach against official documentation.

- [ ] Use **WebSearch** for patterns, best practices, common gotchas
- [ ] Use **Context7** for framework/library docs
  - If not loaded: `mcp-add context7` (lean mode) or skip to WebSearch
- [ ] Add **Best Practices References** section to plan with links

```markdown
## Best Practices References

- [Pattern name](url) - key insight
- [Library docs](url) - relevant section
```

→ **Edit plan file**

---

### Step 2: Task Breakdown

Break the plan into atomic, committable tasks.

- [ ] Create numbered tasks (Task 1, Task 2, ...)
- [ ] Each task must have: **Files**, **Verify**, **Commit**
- [ ] Use TaskCreate/TaskUpdate tools to track progress during implementation

See `references/task-template.md` for format.

→ **Edit plan file**

---

### Step 3: Task Dependencies

Define execution order with a dependency diagram.

- [ ] Use `→` for sequential dependencies
- [ ] Use commas for parallel tasks
- [ ] Make dependencies explicit, not implicit

```
Task 1 → Task 2 → Task 3
Task 4, Task 5 (parallel, after Task 3)
```

→ **Edit plan file**

---

### Step 4: Shared Infrastructure

Identify code that would be duplicated across tasks and define shared locations.

- [ ] Explore existing project structure for conventions (test dirs, types, utils)
- [ ] Identify shared code: test mocks, types, helper utilities
- [ ] Define locations that match the project's existing patterns

Add a **Shared Infrastructure** section listing where shared code lives.

→ **Edit plan file**

---

### Step 5: Completeness Check

Ensure the plan is unambiguous enough for another agent to implement.

- [ ] All types are **DEFINED**, not just referenced
- [ ] All function signatures are **SHOWN**, not just mentioned
- [ ] No `...` or "rest unchanged" placeholders
- [ ] No implicit assumptions about existing code

**Test**: Could someone implement this without asking questions?

→ **Edit plan file** (fix any gaps)

---

### Step 6: Final Verification Task

Add a final task that spawns 3 parallel verification subagents after implementation.

- [ ] Add "Task N: Post-Implementation Verification" to the plan
- [ ] Reference the 3 agents: Compliance, Best Practices, Code Simplifier

See `references/verification-agents.md` for prompts.

```markdown
### Task N: Post-Implementation Verification

**Files**: None (verification only)

**Verify**: Spawn 3 parallel subagents:
1. Compliance Agent (Explore) - verify implementation matches plan
2. Best Practices Agent (general-purpose) - validate against docs
3. Code Simplifier Agent (code-simplifier) - check for over-engineering

**Commit**: None (verification task)
```

→ **Edit plan file**

---

### Step 7: Exit Plan Mode

- [ ] Call **ExitPlanMode** to request user approval
- [ ] Address any feedback
- [ ] Begin implementation once approved

---

## Quick Reference

| Step | Action | Plan Section Added |
|------|--------|-------------------|
| 1 | Research | Best Practices References |
| 2 | Task breakdown | Implementation Tasks |
| 3 | Dependencies | Task Dependencies diagram |
| 4 | Shared code | Shared Infrastructure |
| 5 | Completeness | (fixes throughout) |
| 6 | Verification | Final verification task |
| 7 | Exit | (tool call) |
