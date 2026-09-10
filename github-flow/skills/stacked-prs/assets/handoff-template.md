# Handoff <branch>: <subject> (issue #N)

Mission: execute issue #N. Prerequisite: <previous layer finished; the
worktree base is the top of the stack, not the epic branch>.

## Required reading, in this order

1. <local epic (draft in the orchestration folder): direction and guardrails>
2. <child issue: specification and plan>
3. `gh issue view N --comments`: late instructions, if any.

## Input required from the user

<What to ask BEFORE acting: versions to pin, accounts, pending decisions.
Write "None" when there is nothing: the section stays, so that its absence
is a choice and not an omission.>

## Pre-flight

1. <green baseline: the exact command to run before touching anything>
2. <check the real state of the code against what the issue assumes;
   report every gap before acting>

## File scope

- Editable: <precise list>
- Never: <precise list, what the neighbours' tests protect>

## Main traps

- <trap 1, and why it is one>
- <trap 2>

## Deliverables

1. Commits on **the branch of this worktree**, green verification gate,
   push of THIS branch, never the trunk. No `gh stack add` from the
   worktree: the orchestrator appends the branch to the top of the stack
   with `gh stack link <n> <branch>` from the main checkout.
2. <measurements and proofs expected, as a comment on issue #N>
3. Tick the line in the handoffs README **and** in the local epic.
