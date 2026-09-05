---
name: greenfield-audit
description: >
  Read-only architecture audit that grants the existing code no authority:
  derive the requirements, design the minimal from-scratch architecture, then
  classify every important component KEEP / SIMPLIFY / REPLACE / DELETE.
  Diagnostic in the chat, no file edited.
argument-hint: "<path>"
disable-model-invocation: true
disallowed-tools:
  - Edit
  - Write
  - NotebookEdit
  - AskUserQuestion
---

# Greenfield audit

Scope: `$ARGUMENTS`

When the scope is empty, ask for the path in the chat and stop. This is the
only question the run may ask.

## Stance

The current architecture has no authority. Several generations of agents
produced and modified it. Expect conceptual debt, accidental abstractions, and
inherited decisions whose justification no longer exists.

The goal is not to make the current code more elegant. The goal is to find the
minimal architecture the system needs today and to measure the existing code
against it.

Constraints for the whole run:

- Read-only. The editing tools are removed for the run; do not write through
  Bash either. The diagnostic goes in the chat.
- Do not ask questions mid-run. Collect them in the final "Unknowns" section.
- Cite evidence as `file:line`, or as a commit hash for intent recovered from
  git, for every requirement, invariant, and verdict.
- Follow the phases in order. Emit the Phase 1 lists and the Phase 2 design as
  visible text before the first Phase 3 tool call. Code that has been read
  cannot be unread, so this order is the only protection against anchoring on
  the existing design. A Phase 2 design that appears after an implementation
  file was read is a violation.

Copy this checklist into the response and tick each line when its text is
emitted:

```
Audit progress:
- [ ] Phase 1: five requirement lists and Unproven emitted, no implementation file opened
- [ ] Phase 2: target architecture emitted, still no implementation file opened
- [ ] Phase 3: implementation read, important components inventoried
- [ ] Phase 4: one verdict per component with evidence
- [ ] Output: five sections delivered, no file edited
```

## Phase 1: Requirements

Establish what the system must do from sources that describe behavior, not
from the code that implements it.

Allowed sources in this phase:

- Tests, fixtures, snapshots
- Public entry points: routes, CLI commands, exported API, UI screens. Open an
  entry point only to list what it exposes (route table, command names,
  exported signatures). Stop at the signature; do not follow its imports.
- Persisted schemas, migrations, seed data
- Configuration, environment variables, deployment files
- README, docs, ADRs, issues referenced in the tree
- `git log --oneline` or `--stat` on the scope, and commit messages, to
  recover intent. No `-p`, no `git show`, no `git blame`: they print
  implementation.

Forbidden in this phase: internal modules, services, helpers, hooks, stores,
utilities, or any file whose only role is to implement behavior. Locate them
with Glob, or with Grep in `files_with_matches` mode, to know they exist. Never
Grep in content mode on a forbidden file: that reads it.

Emit five lists as text. Every item cites its source.

1. Behaviors: what a user or a caller observes.
2. Invariants: what must always hold, including data integrity and ordering.
3. Public interfaces: URLs, commands, exported functions, events, file formats.
4. Constraints: runtime, framework, hosting, performance, external systems,
   compliance, team conventions that a rewrite must still respect.
5. Persisted data: every store, its owner, its lifetime, its migration path.

Put anything with no test, doc, or entry point behind it in an "Unproven"
list. An unproven behavior is a candidate for deletion, not a requirement.

## Phase 2: Target architecture

Design the minimal architecture from Phase 1 only. Emit it as text now, before
any Phase 3 tool call.

Rules:

- Each module exists because a Phase 1 item requires it. Cite the item.
- Prefer fewer layers, direct calls, data passed at boundaries, and
  framework-native features over custom mechanisms.
- One owner per persisted store.
- State what is deliberately absent and why.

Deliver:

- Module list: name, responsibility, interface, owned data.
- Dependency direction between modules.
- Absent by design: abstractions the requirements do not justify.

## Phase 3: Inventory of the existing code

Now read the implementation. Map every important component of the scope.

Phase 1 and Phase 2 are frozen from here. A behavior found in code with no
Phase 1 item goes to Unproven. Never add it to the Phase 1 lists and never
amend the Phase 2 design to make room for it.

A component is important when at least one holds:

- It exposes a public interface listed in Phase 1.
- It owns persisted data.
- Three or more files import it.
- Every request or action passes through it.

Group small helpers under the component that owns them. For each component
record: location, responsibility as implemented, callers, what it depends on.

## Phase 4: Compare and classify

Match each component against the Phase 2 target and give one verdict.

| Verdict | Meaning |
|---------|---------|
| KEEP | A target module has the same responsibility and an equivalent interface, naming aside. A rewrite would produce it again. |
| SIMPLIFY | The need exists, but the component carries responsibilities, indirection, or configurability the target does not. |
| REPLACE | The need exists and the current shape is wrong. A full rewrite is acceptable when the result is substantially simpler and more coherent. |
| DELETE | No Phase 1 item requires it, or a framework-native feature already covers it. |

Tie-break rules:

- Doubt resolves to SIMPLIFY or DELETE, never to KEEP.
- Existence is not an argument. Effort already spent is not an argument.
- An abstraction with one implementation and no test that exercises its seam
  is DELETE unless a Phase 1 constraint requires the seam.
- A pass-through layer that adds no invariant is DELETE.
- Prefer deleting an abstraction over improving it.

## Output

Deliver in the chat, in this order, then stop:

1. Requirements: the five Phase 1 lists, then Unproven, as emitted, with the
   Phase 3 additions to Unproven.
2. Target architecture: the Phase 2 text, unchanged.
3. Verdict table: Component | Verdict | Target counterpart | Evidence | Loss if applied.
   Example rows, paths invented:

   ```markdown
   | Component | Verdict | Target counterpart | Evidence | Loss if applied |
   |-----------|---------|--------------------|----------|-----------------|
   | `src/routes/api/posts.ts` | SIMPLIFY | `content` module, `listPosts(filter)` | Behavior 3 (`tests/posts.test.ts:41`). The handler also formats dates and paginates (`posts.ts:20-77`); the target leaves both to the caller. | None. The date format asserted at `tests/posts.test.ts:58` moves with the caller. |
   | `src/lib/EventBus.ts` | DELETE | Absent by design | One publisher and one subscriber (`EventBus.ts:4`, `sync.ts:17`). No Phase 1 item requires the decoupling. | None. `sync.ts:17` calls `reindex()` directly. |
   ```

4. Rewrites proposed: the REPLACE rows grouped by subsystem, with why the
   result is simpler and the main risk. No new components appear here.
5. Unknowns: questions the user must answer before any edit starts.

Do not edit any file. Do not propose a migration order. The diagnostic is the
deliverable.
