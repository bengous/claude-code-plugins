---
name: start
description: >
  Write a plan the way its reviewer reads it: open choices settled first, the plan ordered by what the reviewer is most likely to change, interfaces and files before mechanics, vertical slices each closed by a check, then a fresh session to implement. Use when a design choice is open, the change crosses several modules or interfaces, a refactor reshapes a contract, or the user asks for a thorough plan or a frontier plan. Not for a change you can describe in one sentence.
---

# Plan at the frontiers

Planning writes the plan and its artifacts, nothing else. No code edit until the reviewer approves the plan. The throwaway of step 1 is built before planning starts and is not kept.

Three moves in order: explore or prototype, settle the choices, then plan. The plan is written to `plan.md` at the root of the working directory named by the `Working directory:` line at the end of this skill, and its artifacts live beside it; without that line, both go to `plans/<date>/<slug>/` from the repository root unless the project names another place. Load one reference at a time, when its step starts.

## 1. Size the ceremony

- One sentence describes the diff: no plan. Say so, propose `/vellum:stop`, and implement once the reviewer runs it.
- The idea is still fuzzy: ask the few questions that pin down the goal and what the throwaway must show, then build it without a plan. Look at what it got wrong or right, then plan in a fresh session from what it taught.
- The idea is clear and choices are open: settle them, step 2.

## 2. Settle the open choices

The choices are settled in a grill, in the review page, never by questions in the terminal. You do not start one: call `mcp__vellum__grill_suggest` with the subject and, in one sentence, why the choices need the reviewer, then end your turn. The reviewer starts the grill from the page, with your subject or their own, or does not. Once it is open, a prompt names the transcript and the instructions to read; you ask each round with `mcp__vellum__grill_ask`, and the reviewer ends the grill. `AskUserQuestion` is refused while vellum is live.

A question is asked only when the answer would change the architecture, an interface or the scope. Anything else: take the recommended option and record it in the plan under Assumptions. Without a grill, every open choice becomes an assumption, or a question left open in the plan, named, with the option you would take.

## 3. Write the plan, ordered by probability of revision

What the reviewer is most likely to change comes first, mechanical work last.
A fact sits next to the decision it fixes, never in a preamble. The first line is the plan's `# Title`, which names the approved directory. The plan then opens with the artifacts it relies on, by path: mockup, throwaway, research note.

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

The skill text ends with a `Working directory:` line and a `Review page:` line. Print both in your first message: the link is how the reviewer reaches the page, and nothing else shows it.

With a working directory, the plan is `plan.md` at its root. Once the plan and its artifacts are ready, end your turn: the vellum plugin submits `plan.md` when a turn ends, opens it in the reviewer's browser, and the review comes back as a prompt. An unchanged `plan.md` submits nothing, so a turn that only asks a question opens no version. To submit before the turn ends, call `mcp__vellum__submit`. "Changes requested" names a feedback file: read it, revise `plan.md` and the files it names, end your turn. "Approved" names the final directory the plan now lives in.

The page is open from the start, on the working directory's files, so the reviewer comments before the plan exists. A batch arrives as a prompt headed "Drafting feedback": read the files it names, revise what they point at, then go on with the plan.

While the review runs, files under the working directory are yours to write and files outside it are locked: the codebase changes after the plan is approved.

Implementation starts in a fresh session, with the plan as the prompt.
