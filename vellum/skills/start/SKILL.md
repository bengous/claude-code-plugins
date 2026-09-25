---
name: start
description: >
  Write a plan the way its reviewer reads it: open choices settled first, the plan ordered by what the reviewer is most likely to change, interfaces and files before mechanics, vertical slices each closed by a check, then a fresh session to implement. Use when a design choice is open, the change crosses several modules or interfaces, a refactor reshapes a contract, or the user asks for a thorough plan or a frontier plan. Not for a change you can describe in one sentence.
---

# Plan at the frontiers

Planning writes the plan and its artifacts, nothing else. No code edit until the reviewer approves the plan. A throwaway prototype lives in the working directory and is not kept.

Explore, then let the reviewer pick each next step: settle the choices, draw a screen, try a throwaway, or plan. The plan is written to `plan.md` at the root of the working directory named by the `Working directory:` line at the end of this skill, and its artifacts live beside it; without that line, both go to `plans/<date>/<slug>/` from the repository root unless the project names another place. Load one reference at a time, when its step starts.

## 1. Propose the next step

One sentence describes the diff: no plan. Say so, propose `/vellum:stop`, and implement once the reviewer runs it.

Otherwise explore, then propose the next step with `mcp__vellum__propose`, never by questions in the terminal: the reason in one sentence, the moves you offer, and the index of the one you recommend. The call waits while the reviewer picks in the review page, and returns their pick: "Accepted: <move>." for the one you recommended, "Chose: <move>." for another, one of theirs included, "Own: <text>." for their own words. Take the step picked, then propose again once it is done. The moves:

- `grill`: choices are open and change the architecture, an interface or the scope; `choices` are their titles. Step 2.
- `mockup`: a screen words cannot settle; `screen` names it. `references/visual.md`
- `prototype`: a question only a throwaway answers; `question` names it. It lives in the working directory; one that needs the codebase goes through `/vellum:stop`, and the plan comes in a fresh session from what it taught.
- `plan`: nothing left open. Step 3.

`AskUserQuestion` is refused while vellum is live. A reviewer may also pick a step on their own; it arrives as a prompt in the same words.

## 2. Settle the open choices

The choices are settled in a grill, in the review page. You do not start one: the reviewer opens it by picking a grill, and the answer names the transcript and, the first time, the instructions to read. You ask each round with `mcp__vellum__grill_ask`, which waits and returns the reviewer's reply, and the reviewer ends the grill. No step is proposed while the review is held (a grill, a plan review).

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

The skill text ends with a `Working directory:` line and a `Review page:` line. Print both in your first message: the link is how the reviewer reaches the page, and the band above the prompt, which carries it too, is drawn in the terminal alone.

With a working directory, the plan is `plan.md` at its root. Once the plan and its artifacts are ready, end your turn: the vellum plugin submits `plan.md` when a turn ends, opens it in the reviewer's browser, and the review comes back as a prompt. An unchanged `plan.md` submits nothing, so a turn that only asks a question opens no version. To submit before the turn ends, call `mcp__vellum__submit`. "Reviewer sent" names a batch of the reviewer's: read it. One headed "Plan review: batch <k> on v<N>": revise `plan.md` and the files it names, end your turn; the reviewer may send another batch on the same version meanwhile, which arrives the same way. A batch's "Grill" section is a round's reply that reached you after your turn ended: read it as `grilling.md` says. Its "Choices" section names, for each decision marked in a mockup, the option the reviewer chose: build that option, and drop the others from the plan. "Approved" names the final directory the plan now lives in.

The page is open from the start, on the working directory's files, so the reviewer comments before the plan exists. Such a batch arrives as "Reviewer sent", a file headed "Drafting feedback": revise what it points at, then go on with the plan.

While the review runs, files under the working directory are yours to write and files outside it are locked: the codebase changes after the plan is approved.

While vellum plans, every shell command starts at the project root: chain a cd inside the one command that needs it, and never cd into the working directory.

Implementation starts in a fresh session, with the plan as the prompt.
