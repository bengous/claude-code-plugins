---
name: issue
description: Write or rewrite a GitHub issue as the goal and how to tell it is reached, with nothing of the solution - a problem in two lines, a Done when visual of testable situations, Not this, the author's leads folded - checked by a script before it is published. Use when the user asks to file, write, draft, open, or rewrite an issue.
argument-hint: "[--dry-run] [issue-number] <what is wrong or wanted>"
allowed-tools: Bash(gh repo view:*), Bash(gh issue view:*), Bash(gh issue list:*), Bash(gh issue create:*), Bash(gh issue edit:*), Bash(gh label list:*), Bash(gh api repos/{owner}/{repo}/issues/*), Bash(gh api -X POST repos/{owner}/{repo}/issues/*), Bash(gh api -X PATCH repos/{owner}/{repo}/issues/*), Bash(git log:*), Bash(mktemp:*), Bash(bun ${CLAUDE_SKILL_DIR}/scripts/check-issue.ts *), Read, Grep, Glob
---

# Issue

An issue is the goal and how to tell it is reached. Its reader is a different agent, in a fresh session, with no access to this conversation. It looks at the code itself and plans; an issue that points at the code to change, or hints at a fix, is followed instead of looked past. So the issue holds nothing of the solution.

## Input

`$ARGUMENTS`

- `--dry-run`: do everything but the publish step; print the title, the labels and the body instead.
- Starts with a number: rewrite that issue. Fetch it with `gh issue view <n> --json title,body,labels,url`, keep the facts that still hold, drop the rest.
- Anything else: the request for a new issue.
- Empty: ask one question, "What is wrong, or what do you want?", then continue.

Ask nothing else unless the request cannot be located in the code at all.

## Protocol

1. **What can be tested.** Read the repository's `AGENTS.md` or `CLAUDE.md` for what a cloud session can run there: its test commands, its fixtures, what it cannot reach. Each situation of *Done when* is a test that session can run.
2. **Look.** Read the code the request touches, to know how it behaves today and which situations tell the goal apart from today. Run it when a command shows the behaviour. What you learn sets the situations and the *Today* column; it does not go in the body as a pointer. Search once for a duplicate: `gh issue list --search "<keywords>" --state all --limit 10`, and tell the user what matches.
3. **Body.** Fill the shape below.
4. **Check.** Write the body to `body.md` in a directory from `mktemp -d`, outside the repository, and run `bun ${CLAUDE_SKILL_DIR}/scripts/check-issue.ts <dir>/body.md` from the repository. Each finding names its line: fix it and run the check again, until it exits 0. Exit 2 is a file it cannot read or a settings file it refuses: report it and stop.
   - `visual-size`: the visual moves to `<dir>/<name>.html`, one situation per table row, with no script (`<details>`, `:checked`, SVG and data URI images work). The check takes that file too: `check-issue.ts <dir>/<name>.html`. In the body, *Done when* names it: `the situations of the issue artifact "<name>"`.
5. **Publish.** No question before it: the skill is the guard, and a caller that wants a look first passes `--dry-run`. Labels only from `gh label list`.

   ```bash
   gh issue create --title "<title>" --body-file <dir>/body.md --label "<a>,<b>"
   gh issue edit <n> --body-file <dir>/body.md
   ```

   `--body-file` keeps the markdown intact; inline `--body` breaks on backticks. With an artifact, upload it once the issue has its number, then link it in the body and edit the issue again, after the check:

   ```bash
   gh api -X POST repos/{owner}/{repo}/issues/<n>/artifacts -f type=embedded_html -f name=<name> -F body=@<dir>/<name>.html --jq .html_url
   ```

   On a rewrite, `gh api repos/{owner}/{repo}/issues/<n>/artifacts` lists the artifacts; one of the same name is replaced with `gh api -X PATCH repos/{owner}/{repo}/issues/<n>/artifacts/<number> -F body=@<dir>/<name>.html`. Report the title and the URL.

## Shape

```markdown
<title>

<problem: 1 to 2 lines>

**Done when** <the expected result, then one line on what is contract and what is free>

<the visual of the situations>

**Not this** <3 lines at most>

<details><summary>Author's leads</summary>

- <a fact>

</details>

<sub>Written by <the model of this session></sub>
```

No heading, and no other section: no *Evidence*, *Hints*, *Context* or checkboxes.

**Title.** The state once done, not the action: "An import keeps every person of the file", not "Fix the import".

**Problem.** What is observed and what it costs, in one or two lines. No cause in the code: the reader finds it.

**Done when.** The expected result as a visual that lists its situations, one per row or panel: terminal sessions per situation, a mockup of the states, a timeline, a chart with the target, or a *Today / Expected* table for a plain bug. One line says what is contract and what is free. Each situation is a test a session can run, with what it observes; at least one shows what keeps working as today, marked `no regression`. A visual over 40 lines goes to an issue artifact (step 4).

**Not this.** What the reader must not touch or fix on the way, three lines at most. Omitted when there is nothing to say.

**Author's leads.** Folded. Facts only: a reproduction, a number measured, a constraint from outside the code, a related issue. Never a fix, a direction, a file to change or a numbered plan.

The body asks nothing: no question mark outside code and URLs. A fact the writer is unsure of says so in words.

A repository tunes the caps in `.github/github-flow.json`, under `issue`: `problemLines` (2), `notThisLines` (3), `visualLines` (40). The `pr` skill reads the same file under `pr`.

## Style

- Facts read as facts. Uncertainty is stated, never hidden behind "should" or "maybe".
- One issue, one goal. Two goals means two issues.
- The reader has the code and the tools. Do not paste what a `Read` shows.
