@AGENTS.md

# The factory

Code reaches `dev` through a pull request alone, merged by GitHub once its checks are green. A cloud session started on an issue the owner labelled `ready`, a session on the owner's machine and the review of each pull request all follow the sections below.

## Work

- One issue, one branch from `dev`, one pull request against `dev`.
- In a fresh clone, `bun install --frozen-lockfile` first, and `bun install --cwd <plugin> --frozen-lockfile --ignore-scripts` before a change under `vellum/`, `pinpoint/` or `atlas/`.
- `bun ./scripts/gates/run-gates.ts` and `bun ./scripts/gates/affected.ts test` pass before every push.
- Run the `verify` skill on your change before you open the pull request, and again after any later edit. A hook sends a cloud session back when the working tree changed since `verify` last ran.
- The pull request's title becomes the one commit of the change on `dev`: `type(scope): what the code does`, with `!` after the scope for a breaking change, which the release reads.
- Decide small choices yourself and record them in the PR body. Ask the owner only for a choice that is hard to undo or that changes what a plugin does for its users beyond what the issue asks.

## Code

`AGENTS.md` holds the code standards. Beside them:

- New behaviour comes with a test that fails without it.
- One way to do a thing: reuse the function, the argument convention and the test helper the file already has.
- A plugin's `README.md` lists every skill, command and script flag it ships.

## Pull request body

The owner reads it after the agents. Keep it short. A session on the owner's machine writes the body the `github-flow:pr` skill gives, which holds these four things among its sections.

1. `Closes #N.`, when the pull request closes an issue.
2. At most two lines: the problem, then what the change does.
3. One view of the change: a `diff` block of the logic, a file tree, a table, or an output before and after.
4. **Checks**: the command `verify` ran and its result, with numbers. For a change with nothing to verify, `none` and why. A behaviour only a live session shows, such as a panel, a band or a toast, is named there as not played in a session.

No question to the reviewer, no summary, no history.

## Review comments

Fix a comment that names a real bug. Decline a style preference in one line in its thread. Resolve the thread once it is handled.

The `review` check fails while the review has findings, and only the next review clears it: push a fix. If you think a finding is wrong, reply in its thread with your reason, leave the thread open and stop.

## Stop

Read a pull request's labels before any change to it. One labelled `needs-human` is stopped: `review` or `test` failed on three of its commits, it conflicted with `dev` a third time, or its branch was force-pushed. Make no change, push nothing and reply to nothing until the label is gone.

Never force-push a pull request's branch, and never rebase it: the failed rounds and the conflicts are counted on its commits, so a force-push stops the pull request. Bring `dev` in with a merge.

The owner restarts it by commenting what to do in the pull request's conversation and removing the label. A comment there is the owner's only when its `user.login` is the owner's and its `performed_via_github_app` is null: your own comments carry the same login, through an app. Follow the owner's comment, where it differs from the issue too. Never remove `needs-human` yourself.

## Conflict

A failed `conflict` status means the pull request conflicts with `dev`. Merge `dev` into the branch, resolve so that both changes hold, run the tests, push.

## Owner gate

The `owner-gate` check gives every pull request a tier from its change. `tier:low` merges once `test` and `review` are green. `tier:human` waits for the owner's `human-approved` label; a change that touches a path of `CODEOWNERS` is always `human`.

A pull request against another base than `dev` stays red on `owner-gate` and `review`; after its base is changed to `dev`, a push runs them again.

A red `owner-gate` is the owner's to clear: push nothing for it, and never add `human-approved` yourself. A push removes that label, so push to an approved pull request only to fix a red check.
