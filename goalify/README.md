# goalify

Turn a rough task into the completion condition a `/goal` evaluator can judge.

goalify produces the `/goal` line; it never does the work.

## Invoke

```
/goalify:goalify <task or draft condition>
```

(The short `/goalify` usually resolves too.)

## Modes

- **Draft-first (default)** — `/goalify <task>`. Infers each clause and asks
  only when two readings of the task give two different end states.
- **Interactive** — `/goalify interactive <task>`. Settles each clause with
  AskUserQuestion, one at a time, recommended answer first.

## Output

One `/goal` line, under 4000 characters, built from five clauses:

```text
/goal <end state>, shown by <proof>. <constraints>. <blocker>. <cap>.
```

- **End state**: one measurable fact that holds when the work is done
- **Proof**: the command Claude runs and the output line that shows it
- **Constraints**: what must not change, and what closes the shortcuts
- **Blocker**: reporting a blocker is an end state of its own
- **Cap**: a turn or time bound

Context the worker needs but the evaluator does not goes in a separate message
to send before `/goal`; goalify says so when there is one.

## Why this shape

The `/goal` evaluator judges the condition against the conversation alone. See
[`skills/goalify/references/design-notes.md`](skills/goalify/references/design-notes.md).

## Install

Registered in this repo's `marketplace.json` as `goalify` (`source: ./goalify`).
After syncing, restart Claude Code.
