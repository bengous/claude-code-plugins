## Work

- One issue, one branch from `{{BRANCH}}`, one pull request.
- `bun test` passes before every push.
- Run the `verify` skill on your change before you open the pull request, and again after any later edit. A hook sends you back when the working tree changed since `verify` last ran.
- Write an issue with the `issue` skill and a pull request's body with the `pr` skill; each runs its check before it writes to GitHub.
- Decide small choices yourself. Ask the owner only for a choice that is hard to undo or changes what the tool measures.

## Code

- Validate what comes from outside (stdin, arguments) where it enters, and fail with a one-line message, never a stack trace.
- One way to do a thing: reuse the function, the argument convention and the test helper the file already has.
- New behaviour comes with a test that fails without it.
- The usage text and `README.md` list every command and flag.

## Review comments

Fix a comment that names a real bug. Decline a style preference in one line in its thread. Resolve the thread once it is handled.

The `review` check fails while the review has findings, and only the next review clears it: push a fix. If you think a finding is wrong, reply in its thread with your reason, leave the thread open and stop.

## Stop

Read a pull request's labels before any change to it. One labelled `needs-human` is stopped: `review` or `test` failed on three of its commits, it conflicted with `{{BRANCH}}` a third time, or its branch was force-pushed. Make no change, push nothing and reply to nothing until the label is gone.

Never force-push a pull request's branch, and never rebase it: the failed rounds and the conflicts are counted on its commits, so a force-push stops the pull request. Bring `{{BRANCH}}` in with a merge.

The owner restarts it by commenting what to do in the pull request's conversation and removing the label. A comment there is the owner's only when its `user.login` is the owner's and its `performed_via_github_app` is null: your own comments carry the same login, through an app. Follow the owner's comment, where it differs from the issue too. Never remove `needs-human` yourself.

## Conflict

A failed `conflict` status means the pull request conflicts with `{{BRANCH}}`. Merge `{{BRANCH}}` into the branch, resolve so that both changes hold, run the tests, push.

## Owner gate

The `owner-gate` check gives every pull request a tier from its change. `tier:low` merges once `test` and `review` are green. `tier:human` waits for the owner's `human-approved` label; a change that touches a path of `CODEOWNERS` is always `human`.

A pull request against another base than `{{BRANCH}}` stays red on `owner-gate` and `review`; after its base is changed to `{{BRANCH}}`, a push runs them again.

A red `owner-gate` is the owner's to clear: push nothing for it, and never add `human-approved` yourself. A push removes that label, so push to an approved pull request only to fix a red check.
