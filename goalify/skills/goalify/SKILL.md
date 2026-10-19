---
name: goalify
description: >
  Turn a rough task into the completion condition a `/goal` evaluator can judge:
  an end state, the command that proves it, the constraints that close the
  shortcuts, the blocker that ends the run, the turn cap. Invoke with /goalify
  <task>, or "/goalify interactive" to settle each clause with a question before
  the condition is written. Produces the condition only, never the work.
disable-model-invocation: true
argument-hint: "[interactive] <task or draft condition>"
allowed-tools:
  - Read
  - Grep
  - Glob
  - AskUserQuestion
---

# Goalify

Write the line the user pastes after `/goal`. Nothing else: no plan, no brief,
no context dump, and never the task itself.

A `/goal` condition is read twice. Claude reads it as the directive of the next
turn. A small evaluator model reads it after every turn, against the
conversation alone: it runs no command and opens no file, so it can only judge
what Claude has printed. The condition is written for that second reader. A
clause the evaluator cannot settle from the transcript is a clause that never
resolves, and the loop runs until the turn cap or the user kills it.

## Input

**$ARGUMENTS**

`interactive` as the first word: settle each clause below with AskUserQuestion,
one at a time, the recommended answer first; inspect the repository instead of
asking when it holds the answer. Otherwise infer, and ask only when two readings
of the task give two different end states.

## Five clauses

**End state.** One measurable fact that holds when the work is done, in the
present tense: a test result, an exit code, a file count, an empty queue, a
score at or above a threshold. Not an activity ("migrate the module") but its
trace ("every call site of `oldApi` is gone and the build passes"), and not an
order ("make the case pass") but the fact ("the case passes 20 runs"). Several
facts joined by "and" are one end state; two unrelated ones are two goals, run
in sequence.

**Proof.** The command Claude runs and the exact line of its output that shows
the end state, printed in the conversation: "`bun test --parallel` exits 0 and
its summary shows 0 fail", not "tests pass". Take the command from the
repository's own checks when it has them (`package.json` scripts, `AGENTS.md`,
CI config); write the proof clause first and derive the end state from it when
the task is vague. The proof is the command's own summary line, never an
echoed exit code: `; echo $?` makes the command a compound one that the
permission check prompts on, and a headless run has nobody to answer.

**Constraints.** What must not change on the way, and what closes the shortest
path to the end state that is not the work: test files unchanged, no skipped
test, no `any`, no new dependency, the pinned branch. Before writing them, ask
how the condition could be satisfied without doing the task, and close each
answer. Approval before anything destructive or outward-facing (push, delete,
send, install) is a constraint, not a note.

**Blocker.** The evaluator returns met, not met, or impossible; a stuck run
reads as "not met" forever. Write the blocked outcome as a second end state,
joined to the first by "or": "or a blocker outside Claude's control (a
credential, an external service, a permission the session cannot get, a
decision only the user can take) is named in the conversation with its cause
and what was tried". An instruction ("if blocked, report it") is not an end
state: the evaluator reads the report and still answers "not met", and the run
burns turns repeating it.

**Cap.** A turn or time bound: "or stop after 20 turns and list what remains".
The evaluator judges it from Claude's own count, so it is soft; it is still the
only bound the condition carries.

## Shape

```text
/goal <end state>, shown by <proof>, or <blocker> is named with its cause and what was tried. <constraints>. <cap>.
```

Plain sentences, no labels, no headings: the whole text is the condition, and
the evaluator weighs every word of it. Under 4000 characters, the harness
limit. Context the worker needs but the evaluator does not (why the task
exists, where to start, what was tried) goes in a separate message the user
sends before `/goal`; say so when there is such context, and keep it out of
the condition.

## Output

The response is the `/goal` line, unfenced and ready to paste, then one blank
line, then at most two lines: the context message to send first, when one is
needed, and the goal that should run before this one, when the task splits.
When the repository contradicts the task (a version already bumped, a file
already gone), one line before the condition says what was found, and the
condition is written on what is true.

When the task has no end state a transcript can show (a judgment of taste,
"production-ready", "cleaner"), say so in one sentence and offer the closest
measurable proxy or a Stop hook; do not write a condition that cannot resolve.
