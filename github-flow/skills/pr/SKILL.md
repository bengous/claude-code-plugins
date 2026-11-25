---
name: pr
description: Open or update the pull request of the current branch once the branch is reviewed, with a short body in a fixed shape (why, danger, where to start, one view, proof, decisions, checks) that a bundled script checks before it is published, and images attached through gh. Use when the user asks to open, create, submit, update, or rewrite a PR, or to push and open one.
argument-hint: "[--dry-run] [image.png#alt ...] [what the reviewer should know]"
allowed-tools: Bash(git status:*), Bash(git log:*), Bash(git diff:*), Bash(git branch:*), Bash(git restore:*), Bash(git push:*), Bash(gh repo view:*), Bash(gh issue view:*), Bash(gh pr view:*), Bash(gh pr create:*), Bash(gh pr edit:*), Bash(mktemp:*), Bash(${CLAUDE_PLUGIN_ROOT}/scripts/tree-diff.ts *), Bash(bun ${CLAUDE_SKILL_DIR}/scripts/check-pr.ts *), Skill, Read, Grep, Glob
---

# PR

Agents review the PR first. The body is for the reader who opens it afterwards, human or agent, and needs to act: why the change exists, what breaks if it is wrong, where to start reading, one view of it, the proof, and what ran. It leaves nothing open: every open point is something the next agent reads and loops on. Every view is text, so an agent reads the same facts.

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
   - `git log --oneline origin/<base>..HEAD` and `git diff --stat origin/<base>...HEAD`: the size, the files, and whether the change crosses modules (a plugin, a package, a top-level directory of code).
   - Tests added by the branch: `git diff --stat origin/<base>...HEAD -- '*test*' '*spec*'`.
   - The issue: `Closes #N` in a commit body, else the leading number of the branch name, else none. `gh issue view <n> --json title,body` when there is one. Its situations, a *Done when* table or list, are what **Proof** answers.
   - When the issue has an Out of scope section: every file of `git diff --name-only origin/<base>...HEAD` that it names.
   - The validation commands: the repository's `AGENTS.md` or `CLAUDE.md` names them. Its `GLOSSARY.md` or `CONTEXT.md` when one exists: the words that name the nodes of a view.
   - What ran this session, with its numbers.
4. **View.** One, the smallest that makes the key point clear, from the table under [Views](#views).
   - Moved, added or deleted directories: `${CLAUDE_PLUGIN_ROOT}/scripts/tree-diff.ts origin/<base>` prints the tree diff. A directory moved, added or deleted whole is one line, and a directory where more than three files changed, all of them only modified, is a count. Keep the lines the reader needs and comment each one with what it owns now. Where the skill runs outside its plugin, with no `scripts/tree-diff.ts` beside it, write that tree by hand from `git diff --name-status origin/<base>...HEAD`, by the same rules.
   - A Mermaid diagram, for a topology only: read `references/mermaid.md` first. GitHub's renderer has traps a terminal never shows.
   - Worked examples of every view: `references/views.md`.
5. **Proof.** The issue's situations, before → after: a table, one row per situation, the before observed on the base and the after on the branch.

   A change the reader sees (a page, a view, a component, a stylesheet) proves a state with two stills, Before then After, when `$ARGUMENTS` gave none. The browser tool of the session captures the base state (the live page, else the base branch served) and the branch, one state per file, outside the repo, in a directory from `mktemp -d`. No reachable base: After alone, and the caption says what it shows.

   A transition two stills cannot show (an animation, a navigation, a sequence of gestures) is a still then a clip, three clips at most. Each clip comes with a protocol line, `Protocol: <build>, <viewport>, <page>, <action>`, and names the e2e test that asserts what it shows: a clip no test asserts proves one run. Playwright drives the recording, from a script that touches no file of the repo. Recipe, traps and publishing: `references/video.md`.
6. **Decisions.** The body asks nothing and leaves nothing open. A decision is a file of the diff that the issue puts *Out of scope*, a form the diff leaves open, or a behaviour read but not run whose answer would change the branch.
   - A user in the session: every decision in one `AskUserQuestion`, the option the agent would take first. An answer that changes the code is committed (`/git:commit`).
   - No user, inside a subagent, a `/loop` run or a scheduled task: never call `AskUserQuestion`; decide. A file of the diff that the issue's *Out of scope* names goes back to its `origin/<base>` state in a commit (`git restore --source origin/<base> -- <file>`).
   - **Decided** keeps the three facts a reader would ask about at most, each a choice made, never a question. What cannot be settled here is the next issue's, not this body's.
7. **Review.** Before the body, so the body describes the final head. Wait for each reviewer's report before step 8.
   - `/code-review medium` of the branch against `origin/<base>`: with no level the review runs at the level typed last, and `low` leaves most findings to the pull request's own review, one failed round each. Each finding is fixed and committed, or settled as a fact of **Decided**.
   - `plugin-dev:skill-reviewer` when the diff touches a `SKILL.md` or an `agents/*.md`, its findings under the same rule.
   - The body recaps no review: the reviews live on the pull request.
8. **Body.** Write the shape of [Body](#body) to a file in a directory of its own, from `mktemp -d`, outside the repo. The title follows the convention of `git log --oneline -10`. Then check it:

   ```bash
   bun ${CLAUDE_SKILL_DIR}/scripts/check-pr.ts <tmp>/body.md
   ```

   Each finding is `<file>:<line>: <check>: <message>`, exit 1. Fix the line and run it again until it exits 0; never publish a body it refuses. Exit 2: the file or the repository's settings could not be read, and the message says which.
9. **Publish.** No question about publishing: the skill is the guard, and a caller that wants a look first passes `--dry-run`. Without `--dry-run`, push with `git push -u origin HEAD`. A rejected push: report it verbatim and stop; never force. A PR already open on the branch (`gh pr view --json number,body`) is edited, else one is created:

   ```bash
   gh pr create --base <base> --title "<title>" --body-file <tmp>/body.md --attach '<capture dir>/before.png#<alt>'
   gh pr edit <n> --title "<title>" --body-file <tmp>/body.md --attach '<capture dir>/after.png#<alt>'
   ```

   `--body-file` keeps the markdown intact. A `![alt](<path>)` in the body is rewritten to the uploaded asset when `<path>` is the same string as in `--attach`, and the alt text in the body wins. The image files stay outside the repo, so both strings are the absolute path of the capture, `<capture dir>` that `mktemp -d` directory; `--attach` is their only path to GitHub.
10. **Render check.** A body with a Mermaid block, after a publish. Only GitHub shows the drawing: `gh pr view` returns the markdown. When the session's browser can open the PR (on a private repository, only the user's logged-in browser can), screenshot the diagram, fix what does not read, `gh pr edit <n> --body-file <tmp>/body.md`, and look again: two rounds at most. A diagram that still does not read after them is replaced by a text view of the same nodes.
11. **Report.** The title and the URL.

## Views

| The change | The view |
|---|---|
| Logic, an algorithm | pseudocode as a `diff` |
| Runtime control flow | a call tree, as a `diff` when it changes |
| Moved, added or deleted directories | the tree diff of step 4, in a `diff` block |
| UI structure | a component tree, with the state and module boundaries that matter |
| A topology: an architecture, a data flow, a data model | a Mermaid `flowchart TB` |
| Contrasts that share no shape | a Before / After table, one line per cell |

**One view.** Use `diff` when the point is what changes and the surrounding shape already exists; match the diff shape to the topic: a tree, a call tree, a component tree, pseudocode. A topology whose shape changes is one Mermaid diagram, the delta marked by a `classDef` colour.

Place each visual next to the short text it supports. Keep only the calls, files, props, states, and boundaries needed to answer the reader's question; a table cell that runs past one line is prose in a grid. What a user sees is not the view: its stills and clips are the proof.

Borrowed text and its licences: `CREDITS.md`.

## Body

Each section is a bold lead-in at the start of its line, in this order, each once; no heading, no other section. Worked bodies, which the check passes: `references/bodies/` (a fix, a feature, a UI change, a change across modules).

```markdown
Closes #N.
**Why** one sentence: why the change exists.
**Danger** one-way door or two-way door · reach: what breaks if the change is wrong.
**Start at** the test or the contract the reader opens first; for a change across modules, "read in this order:" then the files.
<the view of step 4>
**Proof** the situations, before → after; for a UI change, the stills, the clips with their protocol line and their e2e test.
**Decided** three facts at most, never a question. Omitted when empty.
**Checks** what ran, with its numbers: the command, passes, failures.
<sub>Written by <the model that wrote the body></sub>
```

- `Closes #N.` when there is an issue.
- **Danger**: a one-way door cannot be undone by reverting the commit (a migration, a published name, a deleted file someone reads); a two-way door can.
- **Proof** writes the stills as `**Before**, <where>:` then `![<what the reader sees>](<capture dir>/before.png)`, the same string as its `--attach`, the same for After. The alt text names what is in the picture, not the file. A clip is `![](<capture dir>/after.mp4)`, with no alt text: GitHub renders it as a player, and the line above it says what to watch for.
- **Checks** names only what ran. A failure that predates the branch is named with its file, the test or symbol it hits, and its cause. A change that alters an output (an error message, a printed report) shows it in **Proof**, before and after: "Tests are green" on its own is a claim, not a before and after.

The check, `scripts/check-pr.ts`, refuses a question anywhere outside code, a section the shape does not have (*Ask*, *Left open*, *Not shown*, *Known gaps*...), a heading, a review recap or a line on what did not run under **Checks** or the footer, more than 120 words of prose outside views, tables and code, more than three facts under **Decided**, and a clip with no protocol line or no e2e test named. A repository sets its own caps in `.github/github-flow.json`, under the key `pr`: `{ "pr": { "proseWords": 120, "decided": 3, "clips": 3 } }`; a cap it leaves out keeps its default.

**Session line.** Under the footer, rendered by GitHub as nothing:

```markdown
<!-- opened_by: ${CLAUDE_SESSION_ID} -->
```

On an update, the `opened_by` line of the current body is kept as it is and `<!-- updated_by: ${CLAUDE_SESSION_ID} -->` goes under it, replacing an earlier `updated_by`. The id names the session to resume (`claude --resume <id>`); inside a subagent it is the parent session's, so a PR a subagent opens names the session that spawned it.

## Style

- Skip all preambles and keep prose brief.
- Facts read as facts, with their numbers. Uncertainty is settled before the body, never hidden behind "should".
- A sentence that repeats a view goes.
- The reviewer has the diff. Do not paste what `gh pr diff` shows; paste the line a decision hangs on.
- Code is named by its file and a symbol in it (a function, a constant, a type, a test name). The body is read after more commits land; a search finds the symbol wherever it moved, while a line number by then points at other code.
- The body is in the language of the repository's recent PRs; a PR written for a named person keeps that person's language.
- No branch history, no thanks, no summary at the end.
