---
name: pr
description: Open or update the pull request of the current branch with a body sized to the change and images attached through gh. Use when the user asks to open, create, submit, update, or rewrite a PR, or to push and open one.
argument-hint: "[--dry-run] [image.png#alt ...] [what the reviewer should know]"
allowed-tools: Bash(git status:*), Bash(git log:*), Bash(git diff:*), Bash(git branch:*), Bash(git rev-parse:*), Bash(git push:*), Bash(gh repo view:*), Bash(gh issue view:*), Bash(gh pr view:*), Bash(gh pr create:*), Bash(gh pr edit:*), Read, Grep, Glob
---

# PR

A PR body is a review brief. Its reader is a different agent, in a fresh session, with the diff and the tools. The body says why the change exists, where to look first, and what was already checked. The body proves; the reviewer judges.

## Input

`$ARGUMENTS`

- `--dry-run`: no push, no publish; print the title, the base, the body and the attachments instead.
- Paths ending in `.png`, `.jpg`, `.gif`, `.mp4`, `.mov`: files to attach. Alt text may follow the path after `#`.
- The rest: what the reviewer should know, kept as facts in the body.
- Empty: everything comes from the branch.

## Protocol

1. **Branch.** `git branch --show-current`. On `dev`, `main`, or the repo's default branch: stop, show `git status --short`, ask for a branch name. Uncommitted changes: stop and say so; the commit comes first (`/git:commit`).
2. **Base.** `dev` when `origin/dev` exists, else `gh repo view --json defaultBranchRef`. Without `--dry-run`, push with `git push -u origin HEAD`. A rejected push: report it verbatim and stop; never force.
3. **Evidence.** Read before citing.
   - `git log --oneline <base>..HEAD` and `git diff --stat <base>...HEAD`: the size, the files.
   - Tests added by the branch: `git diff --stat <base>...HEAD -- '*test*'`.
   - The issue: `Closes #N` in a commit body, else the leading number of the branch name, else none. `gh issue view <n> --json title,body` when there is one.
   - When the issue has an Out of scope section: every file of `git diff --name-only <base>...HEAD` that it names.
   - The repo's `AGENTS.md` or `CLAUDE.md`: the validation commands.
   - What ran this session, with its numbers.
4. **Images.** A change the reader sees (a page, a view, a component, a stylesheet) gets a Before/After pair when `$ARGUMENTS` gave none. The browser tool of the session captures the base state (the live page, else the base branch served) and the branch, one state per file, outside the repo. No reachable base: After alone, and the caption says so. A change with no visible result gets no image.
5. **Body.** Pick the size from step 3, fill the sections below. The title follows the convention of `git log --oneline -10`.
6. **Publish.** No question before it: the skill is the guard, and a caller that wants a look first passes `--dry-run`. Files the issue puts out of scope go in *Ask*, so the reviewer decides. Body in a temporary file outside the repo. A PR already open on the branch (`gh pr view --json number`) is edited, else one is created:

   ```bash
   gh pr create --base <base> --title "<title>" --body-file <tmp> --attach './before.png#<alt>'
   gh pr edit <n> --title "<title>" --body-file <tmp> --attach './after.png#<alt>'
   ```

   `--body-file` keeps the markdown intact. A `![alt](<path>)` in the body is rewritten to the uploaded asset when `<path>` is the same string as in `--attach`, and the alt text in the body wins. The image files stay outside the repo, so both strings are the absolute path of the capture, not `./before.png`; `--attach` is their only path to GitHub. Report the title, the URL, and the out-of-scope files if any.

## Size

Measured on `git diff --stat <base>...HEAD`. A change to a shared module (kernel, lib, a file with more than two consumers) is large whatever its line count.

| Size | Threshold | Sections |
|---|---|---|
| standard | otherwise | Why, What, Ask, Checks, Left open |
| large | ≥ 10 files, or ≥ 300 lines, or a shared module | Why, Files that matter, The code that matters, Ask, Checks, Left open |

## Sections

First line, when there is an issue: `Closes #N.`

**Why.** The problem observed, or the cause for a fix, then what the change does about it. A visual change carries a Before/After pair here: `**Before**, <where>:` then `![<what the reader sees>](./before.png)`, the same for After. The alt text names what is in the picture, not the file.

**What.** One bullet per file or group of files: the path, then what it owns now. The non-obvious choice gets its reason in the same bullet. The bullet that carries the risk comes first.

**Files that matter.** Large only. A table `File | What it owns`, then one paragraph, *The boundary to look at*: the cross-cutting surface, its consumers counted from the code, and what changes for each.

**The code that matters.** Large only. One bold-led paragraph per non-obvious decision: what was tried, what was measured, why this form won, with the snippet the decision hangs on. Skip a decision the diff explains on its own.

**Ask.** What the reviewer decides, and what the author read but could not run. A question, not a claim: "Confirm `LanguageSwitcherIsland` keeps its behaviour: read, not executed."

**Checks.** What ran, with its numbers: the command, passes, failures. A failure that predates the branch is named with its location and its cause. Tests added by the branch are listed apart, each with whether it was seen failing before the change; unknown is written as unknown. Nothing ran this session: run the validation commands from step 3, then report. Never a check that did not run.

**Left open.** What this PR leaves alone, each measured or located: a known limit, a question without an answer, work done outside the diff. Omitted when empty.

## Style

- Facts read as facts, with their numbers. Uncertainty is stated, never hidden behind "should".
- The reviewer has the diff. Do not paste what `gh pr diff` shows; paste the line a decision hangs on.
- An agent reads English; a PR addressed to a person keeps that person's language.
- No branch history, no thanks, no summary at the end.
