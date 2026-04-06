---
name: thorough-plan
description: >
  Adaptive pre-planning exploration loop. Builds sufficient context before
  committing to a detailed plan. Use when: (1) brief is ambiguous or
  underspecified, (2) task touches unfamiliar code or libraries, (3) multiple
  valid approaches exist and the right one isn't obvious, (4) user says
  "thorough plan" or invokes /thorough-plan. NOT for trivial tasks where
  the path is obvious — triage will skip exploration in those cases.
---

# Thorough Plan

An adaptive exploration loop that prevents premature planning. Builds context through codebase exploration, targeted research, and user questions — then hands off to the normal planning flow.

This is not a planning framework. It's a **context amplifier**.

## The problem

Agents fail at planning in predictable ways:
- They plan from incomplete briefs and make wrong assumptions
- They ask questions they could answer by reading the code
- Or they interrogate exhaustively when the task is straightforward

This skill injects judgment: explore what you can, ask what you must, stop when you know enough.

## Workflow

```
BRIEF → TRIAGE → [trivial: skip] → EXPLORATION LOOP → SYNTHESIS → planning
```

### Triage

Read the brief. Evaluate along these dimensions:

- **Ambiguity** — multiple valid interpretations? unclear boundaries?
- **Scope** — how many files/systems? cross-cutting concerns?
- **Risk** — breaking changes? security? data migration?
- **Novelty** — unfamiliar library? new pattern for this codebase?

**Low on all → skip exploration.** State your understanding of the task and proceed directly to planning. Don't explore for the sake of exploring.

**High on any → enter the exploration loop.** Focus exploration on the dimensions that are actually uncertain.

### Exploration loop

This is a loop, not a pipeline. Each iteration:

**1. Explore** — dispatch against specific unknowns, not the whole codebase.

| Unknown type | Tool |
|-------------|------|
| Codebase structure, existing patterns | Explore subagent |
| Library API, version-specific behavior | research-agent → Context7 |
| Code examples, implementation patterns | research-agent → exa (get_code_context) |
| Platform constraints, known issues | research-agent → web search |

Dispatch multiple agents in parallel only when the unknowns are truly independent and the parallel cost is justified. A single focused agent is often enough.

**2. Assess** — what did you learn? what gaps remain?

Share a brief summary with the user — dense, not verbose. A few lines, not paragraphs. Then evaluate the remaining gaps.

**3. Decide** — what to do next.

- Gaps resolvable by further exploration → explore again
- Gaps that need user input → ask questions
- User answers that open new branches → explore again
- Remaining unknowns are weak or acceptable → exit loop

### Questioning

The format adapts to the dependency structure of the unknowns:

- **Independent unknowns** → group them. 3 unrelated questions in one AskUserQuestion is efficient.
- **Dependent unknowns** → sequence them. Answer to Q1 determines whether Q2 matters.
- **Single blocker** → ask just that one.
- **No unknowns left** → don't ask anything.

The test for every question: **would the answer change the plan?** If not, don't ask it.

### Stop criteria

Exit the loop when you can credibly answer:
- What needs to change and why
- What existing code/patterns to reuse
- What constraints apply
- What the user actually wants vs what they literally said

Not every unknown needs resolution. Distinguish:
- **Blocking unknowns** — wrong assumption here means wrong plan. Must resolve.
- **Acceptable unknowns** — state as explicit assumption, revisit during implementation.

### Synthesis

Before proceeding to planning, state your understanding conversationally:
- Key findings from exploration
- Constraints and patterns discovered
- Decisions made (with user or by judgment)
- Remaining assumptions, explicitly listed

No file artifact. This lives in the conversation.

Then proceed to the normal planning flow.

## Escape hatch

The user can type **`::plan`** at any point to force immediate transition to planning. When this happens: state your current understanding (even if incomplete), list open assumptions, and proceed.

## Anti-patterns

| Don't | Do instead |
|-------|-----------|
| Explore by reflex | Explore only dimensions flagged by triage |
| Ask what the codebase could answer | Explore first, ask only what exploration can't resolve |
| Ask generic questions | Every question must have decisional value |
| Write verbose summaries | A few lines per round. Dense, not decorative |
| Run a fixed number of rounds | Stop on sufficiency, not on budget |
| Question exhaustively | Effort proportional to actual ambiguity |
| Produce intermediate files | No intermediate artifacts. Context builds in conversation. Final planning follows the normal workflow |
