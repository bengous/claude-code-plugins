---
name: thorough-plan
description: >
  Adaptive pre-planning exploration loop. Builds sufficient context before
  committing to a detailed plan. Use when: (1) brief is ambiguous or
  underspecified, (2) task touches unfamiliar code or libraries, (3) multiple
  valid approaches exist and the right one isn't obvious, (4) user says
  "thorough plan" or invokes /thorough-plan. NOT for trivial tasks where
  the path is obvious — triage will skip exploration in those cases.
disable-model-invocation: true
model: opus
---

# Thorough Plan

An adaptive exploration loop that prevents premature planning. Builds context through codebase exploration, targeted research, and user questions — then hands off to the normal planning flow.

This is not a planning framework. It's a **context amplifier**.

<context>
Agents fail at planning in predictable ways:
- They plan from incomplete briefs and make wrong assumptions
- They ask questions they could answer by reading the code
- Or they interrogate exhaustively when the task is straightforward

This skill injects judgment: explore what you can, ask what you must, stop when you know enough.
</context>

<workflow>

## Triage

Read the brief. Evaluate along these dimensions:

- **Ambiguity** — multiple valid interpretations? unclear boundaries?
- **Scope** — how many files/systems? cross-cutting concerns?
- **Risk** — breaking changes? security? data migration?
- **Novelty** — unfamiliar library? new pattern for this codebase?

**Low on all → skip exploration.** State your understanding of the task and proceed directly to planning. Don't explore for the sake of exploring.

**High on any → enter the exploration loop.** Focus exploration on the dimensions that are actually uncertain.

<example title="Triage assessment">
Brief: "Add a /sweep command that cleans up stale git branches"

- Ambiguity: low — intent is clear
- Scope: medium — needs new command + script, touches plugin structure
- Risk: low — read-only git operations, no data loss
- Novelty: low — similar commands exist in git-tools/

→ One focused Explore agent on git-tools/ patterns, then proceed to planning. No user questions needed.
</example>

<example title="Triage assessment — high ambiguity">
Brief: "Redesign how plugins handle configuration"

- Ambiguity: high — "redesign" could mean anything from a new config format to a complete architecture change
- Scope: high — touches every plugin
- Risk: high — breaking change for existing plugins
- Novelty: medium — depends on what approach is chosen

→ Explore current config patterns across plugins, then ask the user what "redesign" means to them before exploring further.
</example>

## Exploration loop

This is a loop, not a pipeline. Each iteration:

**1. Explore** — dispatch against specific unknowns, not the whole codebase.

| Unknown type | Tool |
|-------------|------|
| Codebase structure, existing patterns | Explore subagent |
| Library API, version-specific behavior | research-agent → Context7 |
| Code examples, implementation patterns | research-agent → exa (get_code_context) |
| Platform constraints, known issues | research-agent → web search |

Default to a single agent per iteration. Multi-agent dispatch is the exception — use it only when unknowns are truly independent and the parallel cost is justified.

**2. Assess** — what did you learn? what gaps remain?

Share a brief summary with the user — dense, not verbose. A few lines, not paragraphs. Then evaluate the remaining gaps.

**3. Decide** — what to do next.

- Gaps resolvable by further exploration → explore again
- Gaps that need user input → ask questions
- User answers that open new branches → explore again
- Remaining unknowns are weak or acceptable → exit loop

## Questioning

The format adapts to the dependency structure of the unknowns:

- **Independent unknowns** → group them. 3 unrelated questions in one AskUserQuestion is efficient.
- **Dependent unknowns** → sequence them. Answer to Q1 determines whether Q2 matters.
- **Single blocker** → ask just that one.
- **No unknowns left** → don't ask anything.

The test for every question: **would the answer change the plan?** If not, don't ask it.

<example title="Good vs bad questions">
Bad: "What testing framework do you prefer?"
→ Answerable by reading the codebase. Explore first.

Bad: "Should I use a modular architecture?"
→ Too generic. Doesn't change a concrete decision.

Good: "The brief says 'support SSO' — do you mean SAML, OIDC, or both? This determines whether we need one integration or two."
→ Blocks a structural decision. Can't be resolved by exploration.

Good (grouped): "Two independent questions: (1) Should this be backward-compatible with existing configs, or can we break the format? (2) Do you want this behind a feature flag?"
→ Independent unknowns, efficient to ask together.
</example>

## Stop criteria

Exit the loop when you can credibly answer:
- What needs to change and why
- What existing code/patterns to reuse
- What constraints apply
- What the user actually wants vs what they literally said

Not every unknown needs resolution. Distinguish:
- **Blocking unknowns** — wrong assumption here means wrong plan. Must resolve.
- **Acceptable unknowns** — state as explicit assumption, revisit during implementation.

## Synthesis

Before proceeding to planning, state your understanding conversationally:
- Key findings from exploration
- Constraints and patterns discovered
- Decisions made (with user or by judgment)
- Remaining assumptions, explicitly listed

No file artifact. This lives in the conversation.

Then proceed to the normal planning flow.

</workflow>

## Escape hatch

The user can type **`::plan`** at any point to force immediate transition to planning. When this happens: state your current understanding (even if incomplete), list open assumptions, and proceed.

<constraints>

## Principles

| Principle | Rationale |
|-----------|-----------|
| Explore only dimensions flagged by triage | Unfocused exploration wastes context and delays planning |
| Explore before asking the user | The codebase often holds the answer. Reserve user questions for what exploration can't resolve |
| Every question must have decisional value | A question that wouldn't change the plan is noise |
| Summaries stay dense: a few lines per round | Verbose reports consume context without adding clarity |
| Stop on sufficiency, not on a budget | The loop exits when context is adequate, whether that takes 1 iteration or 4 |
| Effort proportional to actual ambiguity | A clear brief with low risk gets minimal exploration. A vague brief with high scope gets thorough investigation |
| No intermediate artifacts — context builds in conversation | Final planning follows the normal workflow |
| Default to one agent per exploration step | Multi-dispatch is justified only when unknowns are truly independent |

</constraints>
