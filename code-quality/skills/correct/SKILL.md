---
name: correct
description: "Turn a mistake that must not recur into a check that fails on it (architecture, type, lint, test or hook; an instruction only for a judgment call), proven red on the past error. Use when the user says a mistake must not happen again or asks to remember a correction or add it to CLAUDE.md, AGENTS.md or a rule file, when the same mistake comes back across sessions or agents, or when a review finding names a class of error rather than one instance. Not for fixing one error in place, such as a typo or a single bug."
argument-hint: "[mistake, commit or review finding]"
allowed-tools: Bash(git log:*), Bash(git diff:*), Bash(git apply:*)
---

# Correct

The next agent sees only the files it opens, copies the nearest example, and takes the shortest path
the checks accept. Move the correction into something that fails.

## 1. Name the class

1. Pin the past error: the diff, commit, review comment or transcript line where it happened. With
   no past error there is nothing to prove a control on; ask for it.
2. Widen it to its class: every place the same mistake can land. Search the tree for siblings, and
   the history for earlier occurrences (`git log --oneline -S '<snippet>'`,
   `git log --oneline --grep '<word>'`).
3. Find the control that should have caught it: a lint rule turned off, a test that stayed green
   while the behaviour broke, a hook that let the call through, an instruction that already said it.

## 2. Take the first rung that holds

Repairing a control found in step 1 comes first. Otherwise try the rungs in order and stop at the
first that makes the past error fail; each later one catches the mistake later, for fewer writers, or
only when obeyed.

1. **Architecture.** Leave the mistake nowhere to be written: one owner per fact, one supported way
   per task. Delete the duplicate an agent would copy, derive a hand-synced list from its source,
   keep internals unexported so the wrong import fails. A move beyond the instance's files is
   proposed before it is coded.
2. **Types.** Make the bad state a value of no type: a discriminated union, a branded type, an
   exhaustive `switch` ending in `never`, under the repo's typecheck gate. The error points to the
   fix through the names it prints: name a brand or a union after what builds it (`UserId`, made by
   `toUserId`).
3. **Lint.** For code that compiles yet is wrong in a way its syntax shows. A built-in rule only when
   its message names the fix (`no-restricted-imports` and `no-restricted-globals` take a custom
   message; `bun x oxlint --rules` lists the rest), else a rule in the repo's oxlint JS plugin
   (`jsPlugins` in `oxlint.config.ts`), enabled by name in `rules`, its message naming the file, type
   or function to use instead. When the tree already holds many instances, fix them in the same
   change or scope the rule to the files that must obey it: a rule left `off` holds nothing.
4. **Test.** For an error only running the code shows. It fails when the behaviour breaks, never when
   only internals change, and its assertion message says what broke.
5. **Hook.** For a mistake that is an action, not code: a tool call, a command, a commit, a push. A
   PreToolUse hook denies the call with a reason naming the right command; a git hook guards commit
   and push. A judgment a model can make from the event alone is a prompt or agent hook, a
   classifier, not prose.
6. **Instruction.** Only for a judgment no code and no classifier can make: one or two lines, the
   rule and its why, in the narrowest file that loads with the work (a path-scoped
   `.claude/rules/<topic>.md`, not the root `AGENTS.md`). Nothing fails when it is skipped; say so.
   When the user asked for an instruction, propose the control found above and keep their choice.

## 3. Prove it red, then green

1. Write the control before fixing the instance, run it on the code that still holds the mistake,
   and keep the failing line. A fix already committed is undone for the run with
   `git diff <fix-sha>~1 <fix-sha> -- <path> | git apply -R`, and put back with the same pipe without
   `-R`.
2. Fix the instances; run it again, green.
3. Keep the past error as the control's fixture, so CI replays the proof:
   - Lint: the rule's test lints a fixture file holding the past code with
     `bun x oxlint -c <config> -f json <file>` and asserts the diagnostic's message (oxlint's
     RuleTester does not run under Bun).
   - Types: a line in a test file that only builds the bad value, `const bad: <Type> = <past value>;`,
     under `// @ts-expect-error <the past error>`. The directive is green for any error on its line,
     so nothing else goes on it; the typecheck fails the day the type loosens.
   - Command hook: its test feeds the payload of the past call, rebuilt from the transcript's
     `tool_use`.
   - Prompt or agent hook: proved in a session that replays the past call. Nothing replays it in CI;
     say so.

A control never seen red is a draft.

## 4. Wire it once and delete what it replaces

- One command, locally and in CI, wired once. A lint rule or a type joins a gate that already runs.
  A new command goes into the repo's single list of gates, where its docs say a gate is added; a
  hooks-kit lane only where the repo has no such list. A lane is wiring, not a rung.
- An exception goes on the line above the offending one with its reason
  (`// oxlint-disable-next-line <rule> -- <reason>`), never as a rule turned off for a file.
- Delete what the control now enforces, the instruction that said it first.
- One class per commit: the control, its fixture and the fixed instances together.

## Reply

Per class: the past error and where it was seen; the rung taken and, one line each, why every rung
above it does not hold; the red command with its failing line, then green; what was deleted.
