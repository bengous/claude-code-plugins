---
name: pr
description: Open or update the pull request of the current branch with a body that shows the change first, as a diagram, a file tree, a shaped diff, a table or screenshots, and images attached through gh. Use when the user asks to open, create, submit, update, or rewrite a PR, or to push and open one.
argument-hint: "[--dry-run] [image.png#alt ...] [what the reviewer should know]"
allowed-tools: Bash(git status:*), Bash(git log:*), Bash(git diff:*), Bash(git branch:*), Bash(git rev-parse:*), Bash(git push:*), Bash(gh repo view:*), Bash(gh issue view:*), Bash(gh pr view:*), Bash(gh pr create:*), Bash(gh pr edit:*), Bash(${CLAUDE_PLUGIN_ROOT}/scripts/tree-diff.ts *), Read, Grep, Glob
---

# PR

Agents review the PR first. The body is for the human who opens it afterwards and wants the essential at a glance: what changed shape, what was checked, what is left to decide. Not a wall of text, not every file. The body shows the change, then says only what a picture cannot. Every view is text, so an agent reads the same facts.

## Input

`$ARGUMENTS`

- `--dry-run`: no push, no publish; print the title, the base, the body and the attachments instead.
- Paths ending in `.png`, `.jpg`, `.gif`, `.mp4`, `.mov`: files to attach. Alt text may follow the path after `#`.
- The rest: what the reviewer should know, kept as facts in the body.
- Empty: everything comes from the branch.

## Protocol

1. **Branch.** `git branch --show-current`. On `dev`, `main`, or the repo's default branch: stop, show `git status --short`, ask for a branch name. Uncommitted changes: stop and say so; the commit comes first (`/git:commit`).
2. **Base.** `dev` when `origin/dev` exists, else `gh repo view --json defaultBranchRef`. `gh` takes that bare name; a `git` command or the script takes `origin/<base>`, since a local branch of that name may be missing or stale. Without `--dry-run`, push with `git push -u origin HEAD`. A rejected push: report it verbatim and stop; never force.
3. **Evidence.** Read before citing.
   - `git log --oneline origin/<base>..HEAD` and `git diff --stat origin/<base>...HEAD`: the size, the files.
   - Tests added by the branch: `git diff --stat origin/<base>...HEAD -- '*test*'`.
   - The issue: `Closes #N` in a commit body, else the leading number of the branch name, else none. `gh issue view <n> --json title,body` when there is one.
   - When the issue has an Out of scope section: every file of `git diff --name-only origin/<base>...HEAD` that it names.
   - The repo's `AGENTS.md` or `CLAUDE.md`: the validation commands. Its `GLOSSARY.md` or `CONTEXT.md` when one exists: the words that name the nodes of a view.
   - What ran this session, with its numbers.
4. **Views.** Pick the smallest view that makes the key point clear, from the table under [Views](#views). A standard change gets one; a large one gets one per concern, three at most, a Before/After pair counting as one. Past three, *Left open* names the views left out.
   - Moved, added or deleted directories: `${CLAUDE_PLUGIN_ROOT}/scripts/tree-diff.ts origin/<base>` prints the tree diff. A directory moved, added or deleted whole is one line, and a directory where more than three files changed, all of them only modified, is a count. Keep the lines the reader needs and comment each one with what it owns now.
   - A Mermaid diagram: read `references/mermaid.md` first. GitHub's renderer has traps a terminal never shows.
   - Worked examples of every view: `references/views.md`.

   A change the reader sees (a page, a view, a component, a stylesheet) gets a Before/After pair when `$ARGUMENTS` gave none. The browser tool of the session captures the base state (the live page, else the base branch served) and the branch, one state per file, outside the repo. No reachable base: After alone, and the caption says so.

   A pair of stills proves a state. A clip proves a transition two images cannot show: an animation, a navigation, a sequence of gestures. Record one only then, and for the After: the Before stays a still, because what it proves is that nothing happened. Playwright drives the recording, from a script that touches no file of the repo. Recipe, traps and publishing: `references/video.md`
5. **Body.** Fill the sections below. The title follows the convention of `git log --oneline -10`. A body with a Mermaid block carries `Diagrams not seen rendered on GitHub.` in *Left open* until step 7 has looked at them.
6. **Publish.** No question before it: the skill is the guard, and a caller that wants a look first passes `--dry-run`. Files the issue puts out of scope go in *Ask*, so the reviewer decides. Body in a temporary file outside the repo. A PR already open on the branch (`gh pr view --json number,body`) is edited, else one is created:

   ```bash
   gh pr create --base <base> --title "<title>" --body-file <tmp> --attach './before.png#<alt>'
   gh pr edit <n> --title "<title>" --body-file <tmp> --attach './after.png#<alt>'
   ```

   `--body-file` keeps the markdown intact. A `![alt](<path>)` in the body is rewritten to the uploaded asset when `<path>` is the same string as in `--attach`, and the alt text in the body wins. The image files stay outside the repo, so both strings are the absolute path of the capture, not `./before.png`; `--attach` is their only path to GitHub. Report the title, the URL, and the out-of-scope files if any.
7. **Render check.** A body with a Mermaid block, after a publish. Only GitHub shows the drawing: `gh pr view` returns the markdown. When the session's browser can open the PR (on a private repository, only the user's logged-in browser can), screenshot each diagram, fix what does not read, `gh pr edit <n> --body-file <tmp>`, and look again: two rounds at most. The last edit replaces the *Left open* line of step 5 with what still does not read, or drops it. No such browser, a worker in a worktree for one: the line stays.

## Views

| The change | The view |
|---|---|
| Something a user sees | Before/After screenshots; a clip for a transition |
| An architecture, a data flow | `flowchart TB` |
| Behaviour over time | `sequenceDiagram`, Before and After in one diagram, split by a `Note` |
| A data model | `flowchart TB` |
| Moved, added or deleted directories | the tree diff of step 4, in a `diff` block |
| Logic, an algorithm | pseudocode as a `diff` |
| Runtime control flow | a call tree |
| UI structure | a component tree, with the state and module boundaries that matter |
| Contrasts that share no shape | a Before / After table, one line per cell |
| A decision in the code | the line it hangs on, in a code block, then two lines |

**One view or two.** The shape survives (the same nodes, some changed): one view, the delta marked by the `+` and `-` lines of a diff or by a `classDef` colour. Use `diff` when the point is what changes and the surrounding shape already exists; match the diff shape to the topic: a tree, a call tree, a component tree, pseudocode. The shape changes (nodes appear, vanish, the flow reroutes): two views, Before then After, with the same node ids and the same direction, so the eye compares them.

**Readers of a shared module.** When the change touches one, a line names its readers, counted from the code, and what changes for each: `Read by io.ts (unchanged), viz-payload.ts (only pg), gedcom.ts (errata notes).` The line goes under the view that shows the module, or in *Ask* when no view shows it. Never as edges: an edge drawn only to say who reads what crosses the drawing.

Place each visual next to the short text it supports. Keep only the calls, files, props, states, and boundaries needed to answer the reader's question; a table cell that runs past one line is prose in a grid.

Borrowed text and its licences: `CREDITS.md`.

## Size

Measured on `git diff --stat origin/<base>...HEAD`. A change to a shared module (kernel, lib, a file with more than two consumers) is large whatever its line count.

| Size | Threshold | Views |
|---|---|---|
| standard | otherwise | one |
| large | ≥ 10 files, or ≥ 300 lines, or a shared module | one per concern, three at most |

The cap counts the views that show the change. The commented file tree and the decision lines of *Before / After* come on top of it.

## Sections

First line, when there is an issue: `Closes #N.`

Then two lines at most, under no heading: the problem observed, or the cause for a fix, then what the change does about it.

**Before / After.** The views of step 4, the one that carries the risk first. A visual change carries its pair here: `**Before**, <where>:` then `![<what the reader sees>](./before.png)`, the same for After. The alt text names what is in the picture, not the file. A clip is written the same way, `![](./after.mp4)`, with no alt text: GitHub renders it as a player, and the line above it says what to watch for. The files the change touches appear as a commented tree, `# <what it owns now>` on each line kept. A non-obvious decision in the code is the line it hangs on, then two lines: what was tried or measured, and why this form won. Skip a decision the diff explains on its own.

**Ask.** What the reviewer decides, and what the author read but could not run. A question, not a claim: "Confirm `LanguageSwitcherIsland` keeps its behaviour: read, not executed."

**Checks.** What ran, with its numbers: the command, passes, failures. A failure that predates the branch is named with its location and its cause. Tests added by the branch go in a table, `| Test | Mutant | Seen failing |`: the change to the code that made the test fail, or `the base branch`, and `yes`, `no` or `unknown`. A change that alters an output (an error message, a printed report) shows that output before and after, in two code blocks: "Tests are green" on its own is a claim, not a before and after. Nothing ran this session: run the validation commands from step 3, then report. Never a check that did not run.

**Left open.** What this PR leaves alone, each measured or located: a known limit, a question without an answer, work done outside the diff, the views left out past three, diagrams not seen rendered. What was not measured goes here too, each with what would measure it (a live session, a device, production data): the human empties or accepts that list before a release. Omitted when empty.

**Session line.** Last line of the body, always, rendered by GitHub as nothing:

```markdown
<!-- opened_by: ${CLAUDE_SESSION_ID} -->
```

On an update, the `opened_by` line of the current body is kept as it is and `<!-- updated_by: ${CLAUDE_SESSION_ID} -->` goes under it, replacing an earlier `updated_by`. The id names the session to resume (`claude --resume <id>`); inside a subagent it is the parent session's, so a PR from a dispatched worker names the session that dispatched it.

## Style

- Skip all preambles and keep prose brief.
- Facts read as facts, with their numbers. Uncertainty is stated, never hidden behind "should".
- A sentence that repeats a view goes.
- The reviewer has the diff. Do not paste what `gh pr diff` shows; paste the line a decision hangs on.
- The body is in the language of the repository's recent PRs; a PR written for a named person keeps that person's language.
- No branch history, no thanks, no summary at the end.
