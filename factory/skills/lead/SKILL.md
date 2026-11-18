---
name: lead
description: "Run one pass of the factory's lead: check the factory's labels, have a red main repaired, dispatch ready issues by labelling them `ready`, wake the cloud session of a pull request that conflicts outside the merge queue, send blocked issues back once their cause is gone, and return a digest. Use when the user asks to run the lead, to run a factory pass, or to work the backlog of a repository the factory runs in."
argument-hint: "[--max <n>] [--dry-run]"
disable-model-invocation: true
allowed-tools: Bash(gh issue:*), Bash(gh pr list:*), Bash(gh pr view:*), Bash(gh pr comment:*), Bash(gh label:*), Bash(gh api:*), Bash(gh run list:*), Bash(gh run view:*), Bash(claude -p *), Bash(${CLAUDE_PLUGIN_ROOT}/scripts/check.ts *), Read, Grep, Glob
---

# Lead

One pass over the tracker of a repository the factory runs in. The state lives on GitHub, in labels, never in a file: a pass that runs twice does its work once.

The cloud sessions do the work and auto-merge lands it. The lead feeds them issues, clears what stops them, and reports. It never merges, never closes a pull request, never pushes, and never adds `owner-ok`: that label is the owner's approval of owner paths, and `owner-gate` refuses one added through an app.

Run it in a local session, signed in to `gh` as the owner. `dispatch.yml` fires the routine only for a `ready` label the owner's account added without an app; the same label added from a cloud session fires nothing.

## Input

`$ARGUMENTS`

- `--max <n>`: issues dispatched this pass. Default 2, for cost.
- `--dry-run`: print each action in place of taking it. No comment, no label, no issue, no message to a session.

## Protocol

1. **Labels.** `"${CLAUDE_PLUGIN_ROOT}/scripts/check.ts" --repo <owner/name>`. A missing label: create it with the command the line gives, and create `needs-info` and `needs-human` the same way when `gh label list --limit 100` does not list them. Any other missing item (ruleset, auto-merge, secret) stops the pass: the factory cannot land, and only the owner fixes it. Report it under *Needs you* and go to the digest.
2. **Main.** `gh run list --branch <default branch> --event push --limit 10 --json workflowName,conclusion,url,headSha`: main is red when the newest run of a workflow failed. Then a fix takes priority over every other issue. Unless an open issue titled `main is red` exists, write one: the failing run's link, its first error line (`gh run view <id> --log-failed`), and a "Done when" list whose first line is that run's workflow green on main. Label it `ready`. It counts toward `--max`.
3. **Triage.** `gh issue list --state open --author <OWNER> --search "sort:created-asc" --limit 100 --json number,title,body,labels`. Drop the ones labelled `ready`, `in-progress`, `blocked`, `needs-info`, `needs-human` or `epic`. Oldest first, `bug` before the rest. A candidate has a "Done when" list the review can check the change against; an issue without one: label `needs-info` and comment what it lacks.
4. **Dispatch.** Add `ready` to the first candidates, up to `--max` with step 2's issue. The label is the dispatch: `dispatch.yml` fires the routine, and its session replaces `ready` with `in-progress`.
5. **Maintain.** `gh pr list --state open --json number,url,headRefName,mergeable,isInMergeQueue,autoMergeRequest,statusCheckRollup,labels`. Skip the ones labelled `needs-human`. A pull request whose checks are red with auto-merge on is its session's to fix: the review's findings wake it. Act only on these:
   - **Wake.** `mergeable: CONFLICTING` and not in the merge queue: its session no longer hears about it. Its id is in the `Claude-Session:` trailer of its commits: `gh api repos/<owner>/<name>/pulls/<pr>/commits --paginate --jq '.[].commit.message'`, the last trailer. Count the PR's comments whose first line is `<!-- lead-wake -->` first: at two, label `needs-human` and leave the PR alone. Otherwise post one, written to a file outside the repository, with `gh pr comment <pr> --body-file <tmp>`, first line `<!-- lead-wake -->`, then the reason. Then send:

     ```bash
     claude -p "Pull request <url> conflicts with <default branch> outside the merge queue. Rebase it on <default branch>, run the tests, push, and keep auto-merge on." --cloud <session id>
     ```

     With no trailer, label `needs-human`.
   - **Owner paths.** A red `owner-gate` that waits for the owner's label goes under *Needs you*. Do not add `owner-ok`.
   - **No auto-merge.** A pull request of the factory with auto-merge off goes under *Needs you*: nothing lands it.
6. **Blocked.** `gh issue list --state open --label blocked --json number,title,comments`. The session's last comment says what blocks the issue. When that cause is gone (the test it names passes on main again, the issue it waits on is closed, main is green), send it back: count its comments whose first line is `<!-- lead-ready -->` first; at two, label `needs-human` and leave it. Otherwise post one, first line `<!-- lead-ready -->`, then the cause and why it is gone; remove `blocked`, add `ready`. It counts toward `--max`. A cause still there goes in the digest.
7. **Digest.** The report is the deliverable.

   ```
   Main         green | red: <run url> -> #<n>
   Dispatched   #<n> <title>
   Woken        <pr url> -> session <id>
   Sent back    #<n> <cause that is gone>
   Blocked      #<n> <first line of the cause>
   Needs info   #<n> <what it lacks>
   Needs you    <pr or issue url>: <reason>
   In flight    <pr url> <checks>, <in queue | auto-merge on>
   ```

   *Needs you* lists each pull request waiting for `owner-ok`, each one or issue labelled `needs-human`, a pull request with auto-merge off, and each item step 1 found missing. An empty section is written empty, not dropped.
