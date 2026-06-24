---
name: goalify
description: >
  Convert rough coding, product, architecture, audit, review, migration,
  cleanup, debugging, or orchestration intent into the smallest useful goal
  payload to hand to a fresh Claude Code agent (a new session, a subagent, or
  /loop). Invoke with /goalify, or "/goalify interactive" to be questioned one
  point at a time before the goal is written. Produces goal text only, never the
  downstream implementation.
disable-model-invocation: true
argument-hint: "[interactive] <rough intent or draft>"
allowed-tools:
  - Read
  - Grep
  - Glob
  - Write
  - AskUserQuestion
---

# Goalify

Convert messy intent into the smallest useful payload to hand to a fresh Claude
Code agent.

You are not doing the downstream work. You produce goal text the human can paste
into a new session, hand to a subagent, or feed to `/loop`, or a local file path
they can pass along. Do not start, run, pause, resume, or complete the work
yourself, and do not launch a subagent to execute it.

## Modes

Default mode is draft-first. Use it for `/goalify`, `make this a goal`, and
similar requests. Infer reasonable details and ask only when a missing detail
materially changes scope, risk, or acceptance criteria.

Interactive mode is question-first. Use it when the user says
`/goalify interactive`, `interroge-moi`, `pose les questions une par une`,
`build this goal with me`, or equivalent. Use the AskUserQuestion tool, one
decision at a time, and put your recommended option first. If a question can be
resolved by inspecting the codebase or local docs, inspect instead of asking.

## Core Principle

A goal needs the durable destination, not a runbook.

Include only information that changes execution:

- objective
- relevant context
- constraints and side-effect boundaries
- success criteria
- validation or evidence
- stop condition
- pause/blocker condition

Do not include generic role text such as "You are Claude Code". Do not restate
obvious working-directory or repository facts unless they materially affect the
goal.

## Prompt Shape

Use a compact structure. Put the objective as the first line without an
`Objective:` label, because the consuming agent reads the first line as the task
statement. Prefer these labels for later sections when they carry real
information:

```text
<objective sentence>
Context:
Constraints:
Success means:
Validate with:
Stop when:
Pause if:
```

Only include useful sections. For simple goals, fewer sections are better.

## Output Rules

The payload is meant to be handed to a fresh agent, so keep it copy-pasteable.

For payloads at or under 4000 characters, output only the raw goal payload. Do
not add headings, analysis, notes, context-placement tables, or a separate
session prompt. Do not start the output with `Objective:`.

For payloads over 4000 characters, write the payload to `.agents/goals/<slug>.md`
with the Write tool and do not reprint it. Then output only:

```text
Wrote: .agents/goals/<slug>.md

Hand it to a fresh agent:
- new session: paste the file contents as the first message
- subagent: pass the file contents as the Agent prompt
- autonomous loop: /loop with the goal
```

Use the actual relative path. If the target is outside the current working
directory, use the absolute path. Goal files live under `.agents/goals/` so the
artifact stays harness-neutral and is not mistaken for tool configuration.

## Slug Rules

Generate slugs automatically from the objective:

- lowercase ASCII
- punctuation and spaces become `-`
- strict safe pattern: `[a-z0-9][a-z0-9._-]{0,80}`
- no `.md` suffix in the slug
- truncate to roughly 60-80 characters
- if there is a collision, add a short suffix

Ask for a slug only if one cannot be derived.

## Clarification Rules

Extract only what affects the goal payload:

- task type
- deliverable
- scope boundaries
- source-of-truth files or artifacts
- acceptance criteria
- validation commands or evidence
- side-effect permissions
- manual approval gates
- stopping condition
- blockers that should pause the goal

In interactive mode, ask one decision at a time with AskUserQuestion. In default
mode, ask only for blocking ambiguity.

## Quality Check

Before final output, verify:

- the output is a goal payload, not a wrapper or a meta-explanation
- short output does not start with `Objective:`
- no generic Claude Code role preamble is included
- success criteria are observable
- validation or evidence is specified when useful
- stop and pause conditions are clear
- the goal instructs the executor to get explicit approval before destructive or
  external/outward-facing side effects
- long payloads are written to `.agents/goals/`, not pasted inline
