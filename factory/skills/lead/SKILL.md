---
name: lead
description: "Run one pass of the factory's lead: check the factory's labels, have a red main repaired, dispatch ready issues by labelling them `ready`, wake the cloud session of a pull request that conflicts with the default branch, send blocked issues back once their cause is gone, and return a digest. Use when the user asks to run the lead, to run a factory pass, or to work the backlog of a repository the factory runs in."
argument-hint: "[--max <n>] [--dry-run]"
disable-model-invocation: true
allowed-tools: Bash(gh issue:*), Bash(gh pr list:*), Bash(gh pr view:*), Bash(gh pr comment:*), Bash(gh label:*), Bash(gh api repos/*/pulls/*/commits*), Bash(gh api repos/*/issues/*/events*), Bash(gh run list:*), Bash(gh run view:*), Bash(claude -p *), Bash(${CLAUDE_PLUGIN_ROOT}/scripts/check.ts *), Read, Grep, Glob
---

# Lead

One pass over the tracker of a repository the factory runs in. The state lives on GitHub, in labels, never in a file: a pass that runs twice does its work once.

The cloud sessions do the work and auto-merge lands it. The lead feeds them issues, clears what stops them, and reports. It never merges, never closes a pull request, never pushes, and never adds `owner-ok`: that label is the owner's approval of owner paths. Nothing technical stops the lead from breaking this rule: it runs `gh` signed in as the owner, so `owner-gate` cannot tell its label from the owner's, and the rule rests on this skill alone. Running the lead under a machine account of its own is what would make the gate hold against it.

Run it in a local session, signed in to `gh` as the owner. `dispatch.yml` fires the routine only for a `ready` label the owner's account added without an app; the same label added from a cloud session fires nothing.

## Input

`$ARGUMENTS`

- `--max <n>`: issues dispatched this pass. Default 2, for cost.
- `--dry-run`: print each action in place of taking it. No comment, no label, no issue, no message to a session.

## Protocol

1. **Labels.** `"${CLAUDE_PLUGIN_ROOT}/scripts/check.ts" --repo <owner/name>`. A missing label: create it with the command the line gives, and create `needs-info` and `needs-human` the same way when `gh label list --limit 100` does not list them. Any other missing item (ruleset, auto-merge, secret) stops the pass: the factory cannot land, and only the owner fixes it. Report it under *Needs you* and go to the digest.
2. **Main.** `gh run list --branch <default branch> --event push --limit 10 --json databaseId,workflowName,conclusion,url,headSha`: main is red when the newest run of a workflow failed. Then a fix takes priority over every other issue. Unless an open issue titled `main is red` exists, write one: the failing run's link, its first error line (`gh run view <databaseId> --log-failed`), and a "Done when" list whose first line is that run's workflow green on main. Label it `ready`. It counts toward `--max`.
3. **Triage.** `gh issue list --state open --author <OWNER> --search "sort:created-asc" --limit 100 --json number,title,body,labels`. Drop the ones labelled `ready`, `in-progress`, `blocked`, `needs-info`, `needs-human` or `epic`. Oldest first, `bug` before the rest. A candidate has a "Done when" list the review can check the change against; an issue without one: label `needs-info` and comment what it lacks.
4. **Dispatch.** Add `ready` to the first candidates, up to `--max` with step 2's issue. The label is the dispatch: `dispatch.yml` fires the routine, and its session replaces `ready` with `in-progress`.
5. **Maintain.** `gh pr list --state open --json number,url,headRefName,mergeable,autoMergeRequest,statusCheckRollup,labels`. Skip the ones labelled `needs-human`. A pull request whose checks are red with auto-merge on is its session's to fix: the review's findings wake it. Act only on these:
   - **Wake.** `mergeable: CONFLICTING`: its session may no longer hear about it. A pull request the queue ejected for a conflict has already woken its session, so this second message costs nothing. Its id is in the `Claude-Session:` trailer of its commits: `gh api repos/<owner>/<name>/pulls/<pr>/commits --paginate --jq '.[].commit.message'`, the last trailer. Count the PR's comments whose first line is `<!-- lead-wake -->` first: at two, label `needs-human` and leave the PR alone. Otherwise post one, written to a file outside the repository, with `gh pr comment <pr> --body-file <tmp>`, first line `<!-- lead-wake -->`, then the reason. Then send:

     ```bash
     claude -p "Pull request <url> conflicts with <default branch>. Bring <default branch> into its branch, resolve the conflict so that both changes hold, run the tests, push, and keep auto-merge on." --cloud <session id>
     ```

     With no trailer, label `needs-human`.
   - **Owner paths.** A red `owner-gate` that waits for the owner's label goes under *Needs you*. Do not add `owner-ok`.
   - **No auto-merge.** A pull request of the factory with auto-merge off goes under *Needs you*: nothing lands it.
6. **Blocked.** `gh issue list --state open --label blocked --json number,title,comments`. The session's last comment says what blocks the issue. When that cause is gone (the test it names passes on main again, the issue it waits on is closed, main is green), send it back: count its comments whose first line is `<!-- lead-ready -->` first; at two, label `needs-human` and leave it. Otherwise post one, first line `<!-- lead-ready -->`, then the cause and why it is gone; remove `blocked`, add `ready`. It counts toward `--max`. A cause still there goes in the digest.

   A test can start failing on main with no push, and then no run of step 2 is red: the first session that meets it reports it here. When a blocked issue names a test that fails on main and no open issue is titled `main is red`, write that issue from the session's comment and label it `ready`, as in step 2.

   An `in-progress` issue with no open pull request that closes it, whose label is more than 30 minutes old (`gh api repos/<owner>/<name>/issues/<n>/events`), goes in the digest under *Stale*, and nothing else is done to it: its session may still be alive, and labelling the issue `ready` again would start a second session on it.
7. **Digest.** The report is the deliverable.

   ```
   Main         green | red: <run url> -> #<n>
   Dispatched   #<n> <title>
   Woken        <pr url> -> session <id>
   Sent back    #<n> <cause that is gone>
   Blocked      #<n> <first line of the cause>
   Stale        #<n> in-progress for <duration>, no pull request
   Needs info   #<n> <what it lacks>
   Needs you    <pr or issue url>: <reason>
   In flight    <pr url> <checks>, <in queue | auto-merge on>
   ```

   *Needs you* lists each pull request waiting for `owner-ok`, each one or issue labelled `needs-human`, a pull request with auto-merge off, and each item step 1 found missing. An empty section is written empty, not dropped.
