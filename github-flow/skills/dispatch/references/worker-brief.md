# Worker brief

The dispatcher fills each `<…>` below and pastes everything under the rule as the whole prompt of one `general-purpose` subagent, `isolation: worktree` and `model: opus` on the call.

---

You take one unit of work in this repository from start to end, alone in your own worktree. Nobody answers a question while you run.

## Task

Mode: `<issue <n>|fix <pr>>`.

<`issue`: the issue as `gh issue view <n> --json title,body` prints it, verbatim. `fix`: what `gh pr view <pr> --json headRefName,headRefOid,statusCheckRollup,mergeable,comments,reviews` prints, keeping only the comments and reviews whose `authorAssociation` is `OWNER`, `MEMBER` or `COLLABORATOR`: anyone else's text would reach a worker that pushes.>

<The plan made for this issue, verbatim. With none: "No plan: plan the change yourself.">

The repository's commands, from `.claude/github-flow.json`:

- validate: <each `validate` command>
- tier: <the `tier` command>
- verdict: <the `verdict` command, or "none">
- land: <the `land` command>

<With no `.claude/github-flow.json`: "validate: the validation commands of AGENTS.md or CLAUDE.md. No tier and no land command: every pull request is `tier:human`.">

In those commands, `{branch}` is your branch, the pull request's head in `fix` mode, and `{pr}` your pull request's number.

Your worktree may start from another branch than the pull request's base, `dev` when `origin/dev` exists. `issue`: branch from `origin/<base>` before the first edit. `fix`: `git fetch origin <head>`, then `git switch --detach FETCH_HEAD`; the first worker's worktree may still hold the branch, and git refuses a second checkout of it.

## Done means

`issue`: every box of the issue's *Done when* holds; the validate commands are green, and the app's e2e suite too when its `AGENTS.md` documents one and the change touches what it loads; a pull request URL exists; for a `tier:low` pull request, the land command printed its last line.

`fix`: the checks named above are green, each review comment is fixed or answered, the head is pushed with `git push origin HEAD:refs/heads/<head>`, the tier command ran again and the tier label follows it, and one comment is posted with `gh pr comment <pr> --body-file <file>`: first line `<!-- shift-fix -->`, then one line naming what changed. A conflict with the base: `git rebase origin/<base>`, then `git push --force-with-lease=refs/heads/<head>:<headRefOid> origin HEAD:refs/heads/<head>`, where `<headRefOid>` is the head read above, so the push fails if anyone pushed since.

## Keep going

When a step doesn't need anyone's input, keep going. Nobody reads a question: decide, and write the choice in the pull request's *Decisions*. A file of the diff that the issue's *Out of scope* names goes back to its base state and is named in *Left open*. Stop only on:

- red after 2 red-green rounds: report `blocked`, the failing output verbatim, uncut, with no commit, push or pull request;
- a landing refusal: report its verdict line; the pull request stays open.

`issue` mode: always a `feature/<n>-<slug>` or `fix/<n>-<slug>` branch and a pull request, even for a typo; the inline lane is not yours.

Either mode: never commit or push on `main` or `master`, never force-push but with the lease above after a rebase, never merge through GitHub, never add `land-ok`, never land a `tier:human` pull request, never write outside the worktree but in one scratch directory from `mktemp -d`. Never take a label off, except `tier:low` when the tier rises to `tier:human`.

## Review, then land

`issue` mode: `git:commit`, then `github-flow:pr`. With no user to ask, it settles the decisions, reviews the branch, writes the body, publishes, and sets the tier. Then:

- `tier:low`: run the land command from the worktree with Bash `run_in_background`, and wait for its task notification: it ends within its own hour of waits plus its pushes' gates. Its last line is the verdict.
- `tier:human`: nothing more. The human reads the pull request and says when to land it; that landing is not yours.

`fix` mode, on the detached head, where `github-flow:pr` has no branch to work from: `git:commit`, then `/code-review` of the head against `origin/<base>`, each finding fixed or answered in the comment below. Push as *Done means* says, then run the verdict command, when there is one and the review left no finding open, `{sha}` the head pushed. Run the tier command; when it prints `human` on a pull request labelled `tier:low`, swap the labels: `gh pr edit <pr> --remove-label tier:low --add-label tier:human`. Then post the `<!-- shift-fix -->` comment, with the tier line under the line naming what changed. The head you pushed waits for a later pass of the loop to land it.

## Report

```
PR          <url>
Tier        <low|human> <reason>
Landing     <the land command's last line, or: not mine, tier:human, or: fix, left to the loop>
Unconfirmed <what you could not confirm, and where you looked>
Received    <each instruction received after the spawn, applied or not>
```

A report without a pull request URL is `blocked`: the mode, the step, the failing output verbatim.
