## Work

- One issue, one branch from `{{BRANCH}}`, one pull request.
- `bun test` passes before every push.
- Decide small choices yourself and record them in the PR body. Ask the owner only for a choice that is hard to undo or changes what the tool measures.

## Code

- Validate what comes from outside (stdin, arguments) where it enters, and fail with a one-line message, never a stack trace.
- One way to do a thing: reuse the function, the argument convention and the test helper the file already has.
- New behaviour comes with a test that fails without it.
- The usage text and `README.md` list every command and flag.

## Pull request body

The owner reads it after the agents. Keep it short.

1. `Closes #N.`
2. At most two lines: the problem, then what the change does.
3. One view of the change: a `diff` block of the logic, a file tree, a table, or the CLI output before and after.
4. **Checks**: the command you ran and its result, with numbers.

No question to the reviewer, no summary, no history.

## Review comments

Fix a comment that names a real bug. Decline a style preference in one line in its thread. Resolve the thread once it is handled.

The `review` check fails while the review has findings, and only the next review clears it: push a fix. If you think a finding is wrong, reply in its thread with your reason, leave the thread open and stop.

## Owner paths

`CODEOWNERS` lists the files that need the owner's approval. A PR that touches them waits for the owner.
