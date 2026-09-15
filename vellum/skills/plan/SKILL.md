---
name: plan
description: >
  Write a plan the way its reviewer reads it: open choices settled first, the plan ordered by what the reviewer is most likely to change, interfaces and files before mechanics, vertical slices each closed by a check, then a fresh session to implement. Use when a design choice is open, the change crosses several modules or interfaces, a refactor reshapes a contract, or the user asks for a thorough plan or a frontier plan. Not for a change you can describe in one sentence.
---

# Plan at the frontiers

Planning writes the plan and its artifacts, nothing else. No code edit until the reviewer approves the plan. The throwaway of step 1 is built before planning starts and is not kept.

Three moves in order: explore or prototype, settle the choices, then plan. The plan is written in the harness's plan mode. Its artifacts live in the working directory named by the `Working directory:` line at the end of this skill when there is one; otherwise in `plans/<date>/<slug>/` from the repository root unless the project names another place. Load one reference at a time, when its step starts.

## 1. Size the ceremony

- One sentence describes the diff: no plan. Say so and implement.
- The idea is still fuzzy: ask the few questions that pin down the goal and what the throwaway must show, then build it without a plan. Look at what it got wrong or right, then plan in a fresh session from what it taught.
- The idea is clear and choices are open: settle them, step 2.

## 2. Settle the open choices

Ask in rounds: every question whose prerequisites are settled, numbered, each with a recommended answer. A question is asked only when the answer would change the architecture, an interface or the scope. Anything else: take the recommended option and record it in the plan under Assumptions.

`assume` from the reviewer closes the round: every remaining question becomes an assumption. A question the reviewer leaves open on purpose stays in the plan, named, with the option you would take.

## 3. Write the plan, ordered by probability of revision

Enter plan mode. What the reviewer is most likely to change comes first, mechanical work last.
A fact sits next to the decision it fixes, never in a preamble. The plan opens with the artifacts it relies on, by path: mockup, throwaway, research note.

1. Decisions taken, each with its fact. Assumptions taken in the reviewer's place. Questions still open.
2. Interfaces, in code blocks: types, signatures, CLI, schemas, result codes. Formats: `references/program-design.md`
3. Files created, changed, deleted.
4. Slices in build order, each with the check that closes it.    `references/slices.md`
5. Out of scope, one line.
6. Mechanics the implementer needs and the reviewer does not: bodies, command strings, error handling. Last, under its own heading.

Omit what a competent implementer derives: branch-by-branch logic, repeated invariants, lists of unaffected behavior, unless one prevents a likely implementation mistake. No length target. Expand when asked.

A diagram or a mockup worth showing: `references/visual.md`

## 4. Hand off

Iterate on the plan with the reviewer until it is approved. A large change, or a plan no human will read, goes through the `plan-reviewer` agent first.

With a working directory, `ExitPlanMode` opens the plan and its artifacts in the reviewer's browser and is refused for now: end your turn. The review comes back as a prompt from the vellum plugin. "Changes requested" names a feedback file: read it, revise the plan, call `ExitPlanMode` again. "Approved" asks for `ExitPlanMode` again with the same plan; that call is allowed, and the working directory is renamed to the plan's slug, links included.

Implementation starts in a fresh session, with the plan as the prompt.
