---
name: field-test
description: "Field-test a plugin of this repository in a real Claude Code session, in the terminal through tmux or in the Claude Desktop app through its windows: the scenario goes red on the base and green on the change, read on the screen, in the files the plugin writes and in what Claude receives. Use when a behaviour change to a hook, pane, band, toast, command, registered tool or skill flow is about to be reported done, when a mod's pane or band must be checked in Claude Desktop, or when the user asks to test a plugin live."
allowed-tools: Bash(bun ./scripts/field-test.ts *), Bash(bun ./scripts/field-test-desktop.ts *)
---

# Field test

Unit tests and the kit (`claude plugin test`) pin the tree a mod hands the engine. A field test plays the change in a real session, on the real engine, and reads what a person sees and what Claude receives. It is **red** on the base and **green** on the change: a scenario that never went red proves nothing.

`scripts/field-test.ts` drives a terminal session, one command per Bash call. How the terminal, the focus and the transcript behave, measured: [references/terminal.md](references/terminal.md).

`scripts/field-test-desktop.ts` drives the Claude Desktop app on Linux with Hyprland: open or show a session, capture its window, click, press keys, read Desktop's log. Which Desktop session runs a mod, and what a click may hit, measured: [references/desktop.md](references/desktop.md). A change that shows in Desktop (a pane, a band, a deep link, a session Desktop opens) is played there too.

## 1. Gate

Field-test when the change alters what happens in a session: a hook's effect, a pane, band or toast, a command, a registered tool, a skill's flow, what Claude receives, a file the plugin writes. A label or wording tweak, a doc, a type, or a refactor the kit tests already pin takes none.

Done when the decision and its reason stand in one line of the report.

## 2. Scenario

From the change's acceptance criteria, write the gestures and, for each, the observable that proves it, on whichever of three sides it shows:

- the **screen**: the pane, the band, the chat (`screen --pane`, `wait`; in Desktop, `shot` then Read the image);
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

Report a table, one row per observable, with the text read on each side, and name what the run did not check (see "Desktop and mobile" in the reference). Then `stop` each session: it removes the tmux session, the `--ref` worktree, the scratch directory and Claude Code's data for it. A Desktop run has no `stop`: undo the install and list what it left, as "Install and clean up" in references/desktop.md says.

| Observable | Base (`<base>`) | Change |
|---|---|---|
| Card after a blind (b), the recommendation | `Using Claude's answer` | `Peek at Claude's` |
| What Claude receives | `Q1: your recommendation` | `Q1: (b)` |

## Commands

```bash
bun ./scripts/field-test.ts start griller-base --ref <base> griller     # session on the base; prints the work directory
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

In Claude Desktop (Desktop runs an installed plugin, not `--plugin-dir`: install the change and undo it after the run as "Install and clean up" in references/desktop.md says, and start a new session for each edit):

```bash
bun ./scripts/field-test-desktop.ts mark                                 # a byte offset into Desktop's log, for log --since
bun ./scripts/field-test-desktop.ts open <cli session uuid>              # import and show, confirmed by Desktop's log; local_<id> shows a Desktop session
bun ./scripts/field-test-desktop.ts new --folder <dir> --prompt "<text>" # the new-session page, prompt box filled
bun ./scripts/field-test-desktop.ts windows                              # Desktop's windows, their workspace and geometry
bun ./scripts/field-test-desktop.ts shot --half                          # capture the main window into a new temporary directory; prints the file
bun ./scripts/field-test-desktop.ts click <x> <y>                        # full-size window coordinates; refuses when the pointer misses
bun ./scripts/field-test-desktop.ts key Enter                            # Escape Backspace Tab Enter Up Down End
bun ./scripts/field-test-desktop.ts log --since <mark> --grep "Warming"  # what Desktop wrote since the mark
bun ./scripts/field-test-desktop.ts process <cli session uuid>           # does a Claude Code process run it
```

`shot`, `click` and `key` take `--window <title>` for a popped-out session; `shot` refuses a window on a workspace the screen does not show unless `--focus`. `click` and `key` move the person's pointer and type on their screen: ask before the first one in a session.
