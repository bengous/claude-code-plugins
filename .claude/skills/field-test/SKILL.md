---
name: field-test
description: "Field-test a plugin of this repository in a real Claude Code session driven through tmux: the scenario goes red on the base and green on the change, read on the screen, in the files the plugin writes and in what Claude receives. Use when a behaviour change to a hook, pane, band, toast, command, registered tool or skill flow is about to be reported done, or when the user asks to test a plugin live."
allowed-tools: Bash(bun ./scripts/field-test.ts *)
---

# Field test

Unit tests and the kit (`claude plugin test`) pin the tree a mod hands the engine. A field test plays the change in a real session, on the real engine, and reads what a person sees and what Claude receives. It is **red** on the base and **green** on the change: a scenario that never went red proves nothing.

`scripts/field-test.ts` drives the session, one command per Bash call. How the terminal, the focus and the transcript behave, measured: [references/terminal.md](references/terminal.md).

## 1. Gate

Field-test when the change alters what happens in a session: a hook's effect, a pane, band or toast, a command, a registered tool, a skill's flow, what Claude receives, a file the plugin writes. A label or wording tweak, a doc, a type, or a refactor the kit tests already pin takes none.

Done when the decision and its reason stand in one line of the report.

## 2. Scenario

From the change's acceptance criteria, write the gestures and, for each, the observable that proves it, on whichever of three sides it shows:

- the **screen**: the pane, the band, the chat (`screen --pane`, `wait`);
- the **files** the plugin writes, under the work directory `start` prints (Read them);
- what **Claude receives**, and what Claude wrote, hidden parts included (`messages`, `messages --last`).

The model's part must not vary from run to run: ask, in the prompt, for the exact form the scenario needs ("each recommendation is the bare letter in parentheses"). Keep any text you will search for out of the prompt itself.

Done when every acceptance criterion has a gesture and an observable.

## 3. Red on the base

Start the session on the code before the change, with `--ref` naming that commit (the fix's parent; for a branch, its merge-base with `origin/dev`), and play the scenario. The observable must show the bug. A base that stays green means the scenario misses the bug: rework it before going on. A new feature has no red: write "new feature, no base" and go on.

Done when the red is seen, or the step is marked as a new feature.

## 4. Green on the change

Start a second session on the change (no `--ref`: the working tree, uncommitted edits included) and play the same gestures. Every observable must show the intended behaviour; add one neighbouring gesture that must still work as before.

Done when every observable of step 2 is checked on the change.

## 5. Report and stop

Report a table, one row per observable, with the text read on each side, and name what the run did not check (see "Desktop and mobile" in the reference). Then `stop` each session: it removes the tmux session, the `--ref` worktree, the scratch directory and Claude Code's data for it.

| Observable | Base (`1e2d8e51`) | Change |
|---|---|---|
| Card after a blind (b), the recommendation | `Using Claude's answer` | `Peek at Claude's` |
| What Claude receives | `Q1: your recommendation` | `Q1: (b)` |

## Commands

```bash
bun ./scripts/field-test.ts start griller-base --ref 1e2d8e51 griller   # session on the base; prints the work directory
bun ./scripts/field-test.ts send griller-base "/griller:grill <topic and the exact form wanted>"
bun ./scripts/field-test.ts wait griller-base "of 2 answered"            # until the text shows; --gone until it leaves
bun ./scripts/field-test.ts messages griller-base --last                 # what Claude wrote, hidden parts included
bun ./scripts/field-test.ts press griller-base "(b)" --nth 1             # Tab to that control, then Enter
bun ./scripts/field-test.ts screen griller-base --pane                   # the docked pane alone
bun ./scripts/field-test.ts focused griller-base                         # the control the keys go to
bun ./scripts/field-test.ts keys griller-base C-x Tab                    # raw tmux keys
bun ./scripts/field-test.ts stop griller-base
```

`start` takes `--model` (default `sonnet`), `--width` and `--height` (default 220 × 50), and `--cwd <dir>` to run in a directory you prepared, whose Claude Code data `stop` then leaves alone.
