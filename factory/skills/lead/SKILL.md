---
name: lead
description: "Run one pass of the factory's lead: check the factory's labels, have a red main repaired, dispatch ready issues by labelling them `ready`, wake the cloud session of a pull request that conflicts with the default branch, send blocked issues back once their cause is gone, and return a digest. Use when the user asks to run the lead, to run a factory pass, or to work the backlog of a repository the factory runs in."
argument-hint: "[--max <n>] [--dry-run]"
disable-model-invocation: true
allowed-tools: Bash(gh repo view:*), Bash(gh api user:*), Bash(gh issue list:*), Bash(gh issue view:*), Bash(gh issue create:*), Bash(gh issue comment:*), Bash(gh issue edit:*), Bash(gh pr list:*), Bash(gh pr view:*), Bash(gh pr comment:*), Bash(gh label list:*), Bash(gh label create:*), Bash(gh api repos/*/pulls/*/commits*), Bash(gh api repos/*/issues/*/events*), Bash(gh run list:*), Bash(gh run view:*), Bash(claude -p * --cloud *), Bash(${CLAUDE_PLUGIN_ROOT}/scripts/check.ts *), Read, Grep, Glob
---

# Lead

One pass over the tracker of a repository the factory runs in. The state lives on GitHub, in labels, never in a file: a pass that runs twice does its work once.

The cloud sessions do the work and auto-merge lands it. The lead feeds them issues, clears what stops them, and reports. It never merges, never closes a pull request, never pushes, and never adds `owner-ok`: that label is the owner's approval of owner paths. Nothing technical holds the lead to this. It runs `gh` signed in as the owner, so `owner-gate` cannot tell its label from the owner's; and `allowed-tools` only pre-approves the commands it lists, it restricts nothing, and no pattern there can stop a flag or a label added to a pre-approved command such as `gh issue edit`. The rule rests on this skill alone. Running the lead under a machine account of its own is what would make the gate hold against it.

Run it in a local session, from a checkout of the repository, signed in to `gh` as the owner. `dispatch.yml` fires the routine only for a `ready` label the owner's account added without an app; the same label added from a cloud session fires nothing.

Only the owner's text reaches a session: the lead writes issues and labels them `ready` from what it reads, so it reads issues, comments and pull requests by `<OWNER>` alone and ignores everyone else's. A cloud session comments and opens pull requests under the owner's account, so its text counts as the owner's.

## Input

`$ARGUMENTS`

- `--max <n>`: issues dispatched this pass. Default 2, for cost.
- `--dry-run`: print each action in place of taking it. No comment, no label, no issue, no message to a session.

## Protocol

1. **Inputs.** `gh repo view --json nameWithOwner,defaultBranchRef` gives `<owner/name>` and `<default branch>` (`defaultBranchRef.name`); `gh api user --jq .login` gives `<OWNER>`, the login every step below trusts.
2. **Labels.** `"${CLAUDE_PLUGIN_ROOT}/scripts/check.ts" --repo <owner/name>`. A missing label: create it with the command the line gives, and create `needs-info` and `needs-human` the same way when `gh label list --limit 100` does not list them. A line marked `not visible` goes under *Needs you*, and the pass carries on. Any other `missing` item (ruleset, auto-merge, secret) stops the pass: the factory cannot land, and only the owner fixes it. Report it under *Needs you* and go to the digest.
3. **Main.** `gh run list --branch <default branch> --event push --limit 10 --json databaseId,workflowName,conclusion,url,headSha`: main is red when the newest run of a workflow failed. Then a fix takes priority over every other issue. Unless an open issue titled `main is red` exists, write one with `gh issue create`: the failing run's link, its workflow's name, its first error line (`gh run view <databaseId> --log-failed`), and a "Done when" list whose first line is that workflow green on main. Label it `ready`. It counts toward `--max`. Count first how many of that workflow's newest runs in the list failed in a row: at three, two fixes landed without turning it green, so write none and put the red run under *Needs you*. The count ends at the last green run, so an old incident never holds back a new one.
4. **Triage.** `gh issue list --state open --author <OWNER> --search "sort:created-asc" --limit 100 --json number,title,body,labels`. Drop the ones labelled `ready`, `in-progress`, `blocked`, `needs-info`, `needs-human` or `epic`. Oldest first, `bug` before the rest. A candidate has a "Done when" list the review can check the change against; an issue without one: label `needs-info` and comment what it lacks.
5. **Dispatch.** While step 3 found main red, add `ready` to no issue but a `main is red` one, here or at step 7: any other session started on a red main ends `blocked`. Otherwise add `ready` to the first candidates with `gh issue edit <n> --add-label ready`, up to `--max` with step 3's issue. The label is the dispatch: `dispatch.yml` fires the routine, and its session replaces `ready` with `in-progress`.
6. **Maintain.** `gh pr list --state open --author <OWNER> --json number,url,headRefName,mergeable,autoMergeRequest,statusCheckRollup,labels`. A pull request of the factory is one of these whose commits carry a `Claude-Session:` trailer: `gh api repos/<owner/name>/pulls/<pr>/commits --paginate --jq '.[].commit.message'`, and the last trailer is its session's URL, whose last segment, `session_…`, is the id `--cloud` takes. Every other open pull request (a person's, Renovate's, a fork's) is left alone and not listed. Skip the ones labelled `needs-human`. A pull request whose checks are red with auto-merge on is its session's to fix: the review's findings wake it. Act only on these:
   - **Wake.** `mergeable: CONFLICTING`: its session may no longer hear about it. Where the repository has a merge queue, a pull request it ejected for a conflict has already woken its session, so this second message costs nothing. Count first, in `gh pr view <pr> --json comments`, the comments by `<OWNER>` whose first line is `<!-- lead-wake -->`: at two, label it `needs-human` with `gh issue edit <pr> --add-label needs-human` and leave it alone. Otherwise post one with `gh pr comment <pr> --body "<!-- lead-wake -->` and, on the next line, the reason`"`. Then send:

     ```bash
     claude -p "Pull request <url> conflicts with <default branch>. Bring <default branch> into its branch, resolve the conflict so that both changes hold, run the tests, push, and keep auto-merge on." --cloud <session id>
     ```

   - **Owner paths.** A red `owner-gate` that waits for the owner's label goes under *Needs you*. Do not add `owner-ok`.
   - **No auto-merge.** A pull request of the factory with auto-merge off goes under *Needs you*: nothing lands it.
7. **Blocked.** `gh issue list --state open --author <OWNER> --label blocked --json number,title,comments`. The session's comment is the last comment by `<OWNER>`, and it says what blocks the issue. When that cause is gone (the test it names passes on main again, the issue it waits on is closed, main is green), send it back: count first its comments by `<OWNER>` whose first line is `<!-- lead-ready -->`; at two, label `needs-human` and leave it. Otherwise post one with `gh issue comment <n> --body "<!-- lead-ready -->` and, on the next line, the cause and why it is gone`"`; then `gh issue edit <n> --remove-label blocked --add-label ready`. It counts toward `--max`. A cause still there goes in the digest.

   A test can start failing on main with no push, and then no run of step 3 is red: the first session that meets it reports it here. When a blocked issue names a test that fails on main and no open issue is titled `main is red`, write that issue from the session's comment and label it `ready`, as in step 3, under the same bound.

   An `in-progress` issue with no open pull request that closes it, whose label is more than 30 minutes old, and a `ready` issue that has not become `in-progress` 30 minutes after its label (its dispatch started no session), go in the digest under *Stale*; `gh api repos/<owner/name>/issues/<n>/events --paginate` dates each label. Nothing else is done to them: a session may still be alive, and labelling the issue `ready` again would start a second one on it.
8. **Digest.** The report is the deliverable.

   ```
   Main         green | red: <run url> -> #<n>
   Dispatched   #<n> <title>
   Woken        <pr url> -> session <id>
   Sent back    #<n> <cause that is gone>
   Blocked      #<n> <first line of the cause>
   Stale        #<n> in-progress for <duration>, no pull request
                #<n> ready for <duration>, not taken
   Needs info   #<n> <what it lacks>
   Needs you    <pr or issue url>: <reason>
   In flight    <pr url> <checks>, <in queue | auto-merge on>
   ```

   *Needs you* lists each pull request of the factory waiting for `owner-ok`, each one or issue labelled `needs-human`, a pull request of the factory with auto-merge off, each item step 2 found missing or not visible, and a red run step 3 stopped writing issues for. An empty section is written empty, not dropped.
