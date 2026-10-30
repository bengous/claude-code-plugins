---
name: pr
description: Open or update the pull request of the current branch once the branch is reviewed, with a body that shows the change first, as a diagram, a file tree, a shaped diff, a table or screenshots, and images attached through gh, then label it with its review tier. Use when the user asks to open, create, submit, update, or rewrite a PR, or to push and open one.
argument-hint: "[--dry-run] [image.png#alt ...] [what the reviewer should know]"
allowed-tools: Bash(git status:*), Bash(git log:*), Bash(git diff:*), Bash(git branch:*), Bash(git rev-parse:*), Bash(git restore:*), Bash(git push:*), Bash(gh repo view:*), Bash(gh issue view:*), Bash(gh pr view:*), Bash(gh pr create:*), Bash(gh pr edit:*), Bash(gh label create:*), Bash(mktemp:*), Bash(${CLAUDE_PLUGIN_ROOT}/scripts/tree-diff.ts *), Skill, Read, Grep, Glob
---

# PR

Agents review the PR first. The body is for the human who opens it afterwards and wants the essential at a glance: what changed shape, what was checked, what was decided, and what is left open. Not a wall of text, not every file. The body shows the change, then says only what a picture cannot. Every view is text, so an agent reads the same facts.

## Input

`$ARGUMENTS`

- `--dry-run`: no push, no publish; print the title, the base, the body and the attachments instead.
- Paths ending in `.png`, `.jpg`, `.gif`, `.mp4`, `.mov`: files to attach. Alt text may follow the path after `#`.
- The rest: what the reviewer should know, kept as facts in the body.
- Empty: everything comes from the branch.

## Protocol

1. **Branch.** `git branch --show-current`. On `dev`, `main`, the repo's default branch, or no branch: stop, show `git status --short`, ask for a branch name; with no user to ask, report `no branch` and stop. Uncommitted changes: stop and say so; the commit comes first (`/git:commit`).
2. **Base.** `dev` when `origin/dev` exists, else `gh repo view --json defaultBranchRef`. `gh` takes that bare name; a `git` command or the script takes `origin/<base>`, since a local branch of that name may be missing or stale.
3. **Evidence.** Read before citing.
   - `git log --oneline origin/<base>..HEAD` and `git diff --stat origin/<base>...HEAD`: the size, the files.
   - Tests added by the branch: `git diff --stat origin/<base>...HEAD -- '*test*'`.
   - The issue: `Closes #N` in a commit body, else the leading number of the branch name, else none. `gh issue view <n> --json title,body` when there is one.
   - When the issue has an Out of scope section: every file of `git diff --name-only origin/<base>...HEAD` that it names.
   - The repo's `.claude/github-flow.json`: the `validate` commands, and the `verdict` and `tier` commands of steps 8 and 9. Without the file, the validation commands of its `AGENTS.md` or `CLAUDE.md`. Its `GLOSSARY.md` or `CONTEXT.md` when one exists: the words that name the nodes of a view.
   - What ran this session, with its numbers.
4. **Views.** Pick the smallest view that makes the key point clear, from the table under [Views](#views). A standard change gets one; a large one gets one per concern, three at most, a Before/After pair counting as one. Past three, *Left open* names the views left out.
   - Moved, added or deleted directories: `${CLAUDE_PLUGIN_ROOT}/scripts/tree-diff.ts origin/<base>` prints the tree diff. A directory moved, added or deleted whole is one line, and a directory where more than three files changed, all of them only modified, is a count. Keep the lines the reader needs and comment each one with what it owns now.
   - A Mermaid diagram: read `references/mermaid.md` first. GitHub's renderer has traps a terminal never shows.
   - Worked examples of every view: `references/views.md`.

   A change the reader sees (a page, a view, a component, a stylesheet) gets a Before/After pair when `$ARGUMENTS` gave none. The browser tool of the session captures the base state (the live page, else the base branch served) and the branch, one state per file, outside the repo, in a directory from `mktemp -d`. No reachable base: After alone, and the caption says so.

   A pair of stills proves a state. A clip proves a transition two images cannot show: an animation, a navigation, a sequence of gestures. Record one only then, and for the After: the Before stays a still, because what it proves is that nothing happened. Playwright drives the recording, from a script that touches no file of the repo. Recipe, traps and publishing: `references/video.md`
5. **Decisions.** The body asks nothing. A decision is a file of the diff that the issue puts *Out of scope*, a form the diff leaves open, or a behaviour read but not run whose answer would change the branch.
   - A user in the session: every decision in one `AskUserQuestion`, the option the agent would take first. An answer that changes the code is committed (`/git:commit`). *Decisions* records each answer as a choice made.
   - No user, inside a subagent, a `/loop` run or a scheduled task: never call `AskUserQuestion`; decide. A file of the diff that the issue's *Out of scope* names goes back to its `origin/<base>` state in a commit (`git restore --source origin/<base> -- <file>`), and *Left open* names it with what it would have fixed. Each choice goes in *Decisions*.
6. **Review.** Before the body, so the body and the tier describe the final head. Wait for each reviewer's report before step 7.
   - `/code-review` of the branch against `origin/<base>`. Each finding is fixed and committed, or answered in *Decisions*. On an update of a PR whose comments hold a `<!-- land-ok: void approved=<sha> … -->` line newer than its last `land-ok`: the review reads `git diff <sha>..HEAD` alone, the human having read the rest, and *Checks* says `reviewed since <sha>`.
   - `plugin-dev:skill-reviewer` when the diff touches a `SKILL.md` or an `agents/*.md`, its findings under the same rule.
   - A reviewer that cannot run or never reports: *Checks* says `not reviewed: <why>`, no verdict is posted, and the tier is `human`.
7. **Body.** Fill the sections below. The title follows the convention of `git log --oneline -10`. A body with a Mermaid block carries `Diagrams not seen rendered on GitHub.` in *Left open* until step 10 has looked at them.
8. **Publish.** No question about publishing: the skill is the guard, and a caller that wants a look first passes `--dry-run`. Without `--dry-run`, push with `git push -u origin HEAD`. A rejected push: report it verbatim and stop; never force. Body in a file of a directory of its own, from `mktemp -d`, outside the repo. A PR already open on the branch (`gh pr view --json number,body`) is edited, else one is created:

   ```bash
   gh pr create --base <base> --title "<title>" --body-file <tmp> --attach '<capture dir>/before.png#<alt>'
   gh pr edit <n> --title "<title>" --body-file <tmp> --attach '<capture dir>/after.png#<alt>'
   ```

   `--body-file` keeps the markdown intact. A `![alt](<path>)` in the body is rewritten to the uploaded asset when `<path>` is the same string as in `--attach`, and the alt text in the body wins. The image files stay outside the repo, so both strings are the absolute path of the capture, `<capture dir>` that `mktemp -d` directory; `--attach` is their only path to GitHub.

   Then, without `--dry-run`, the `verdict` command of `.claude/github-flow.json` when it has one, once every reviewer of step 6 reported and left no finding open: `{branch}` is the branch, `{sha}` the head pushed (`git rev-parse HEAD`). It posts on the PR that a review of that head came out clean.
9. **Tier.** The `tier` command of `.claude/github-flow.json`, `{pr}` filled. It prints one line, `low <reason>` or `human <reason>`. That line goes in *Checks*, and one edit carries the body and the label: `gh pr edit <n> --body-file <tmp> --add-label tier:low`, or `tier:human`. A label the repository lacks is created first: `gh label create tier:low --description "Lands on green checks without a human"`, or `tier:human` with `"Waits for the human's land #N"`.
   - The tier only goes up. On an update, `human` over a PR labelled `tier:low` replaces it: `--remove-label tier:low --add-label tier:human`. `low` over a PR labelled `tier:human` leaves the label as it is.
   - No file, no `tier` key, or the command failing or denied: `tier:human`, its reason `no tier command in .claude/github-flow.json` or the first line of the failure. A branch step 6 left `not reviewed` is `tier:human` whatever the line says.
   - Under `--dry-run`: the line is printed and no label is added; with no PR open, the tier waits for the publish.
10. **Render check.** A body with a Mermaid block, after a publish. Only GitHub shows the drawing: `gh pr view` returns the markdown. When the session's browser can open the PR (on a private repository, only the user's logged-in browser can), screenshot each diagram, fix what does not read, `gh pr edit <n> --body-file <tmp>`, and look again: two rounds at most. The last edit replaces the *Left open* line of step 7 with what still does not read, or drops it. No such browser, a worker in a worktree for one: the line stays.
11. **Report.** The title, the URL, the tier line, and the files *Left open* names.

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

**Readers of a shared module.** When the change touches one, a line names its readers, counted from the code, and what changes for each: `Read by io.ts (unchanged), viz-payload.ts (only pg), gedcom.ts (errata notes).` The line goes under the view that shows the module, else as its own line under *Before / After*. Never as edges: an edge drawn only to say who reads what crosses the drawing.

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

**Decisions.** One entry per choice the diff does not explain alone: what was kept, the alternative set aside, why (read or measured), and the line that undoes it. No question mark. A decision the human would overturn is a review comment, which `shift` hands to a `fix <pr>` worker.

**Checks.** The tier line of step 9, as printed; on an update where the tier stayed `human` over a `low` line, `human, kept` above it. The review of step 6: each reviewer, its findings, and what became of each. What ran, with its numbers: the command, passes, failures. A failure that predates the branch is named with its location and its cause. Tests added by the branch go in a table, `| Test | Mutant | Seen failing |`: the change to the code that made the test fail, or `the base branch`, and `yes`, `no` or `unknown`. A change that alters an output (an error message, a printed report) shows that output before and after, in two code blocks: "Tests are green" on its own is a claim, not a before and after. Nothing ran this session: run the validation commands from step 3, then report. Never a check that did not run.

**Left open.** What this PR leaves alone, each measured or located: a known limit, work done outside the diff, a file sent back out of scope, the views left out past three, diagrams not seen rendered. What was read but not run, as a fact with what would run it: "`LanguageSwitcherIsland` keeps its props: read, not run; its e2e page would run it." What was not measured goes here too, each with what would measure it (a live session, a device, production data): the human empties or accepts that list before a release. Omitted when empty.

**Session line.** Last line of the body, always, rendered by GitHub as nothing:

```markdown
<!-- opened_by: ${CLAUDE_SESSION_ID} -->
```

On an update, the `opened_by` line of the current body is kept as it is and `<!-- updated_by: ${CLAUDE_SESSION_ID} -->` goes under it, replacing an earlier `updated_by`. The id names the session to resume (`claude --resume <id>`); inside a subagent it is the parent session's, so a PR from a dispatched worker names the session that dispatched it.

## Style

- Skip all preambles and keep prose brief.
- Facts read as facts, with their numbers. Uncertainty is stated, never hidden behind "should".
- No question to the reviewer: a decision is settled in *Decisions*, or it is a fact of *Left open*.
- A sentence that repeats a view goes.
- The reviewer has the diff. Do not paste what `gh pr diff` shows; paste the line a decision hangs on.
- The body is in the language of the repository's recent PRs; a PR written for a named person keeps that person's language.
- No branch history, no thanks, no summary at the end.
