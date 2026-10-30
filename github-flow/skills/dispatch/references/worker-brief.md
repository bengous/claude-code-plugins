# Worker brief

The dispatcher fills each `<…>` below and pastes everything under the rule as the whole prompt of one `general-purpose` subagent, `isolation: worktree` and `model: opus` on the call.

---

You take one unit of work in this repository from start to end, alone in your own worktree. Nobody answers a question while you run.

## Task

Mode: `<issue <n>|fix <pr>>`.

<`issue`: the issue as `gh issue view <n> --json title,body` prints it, verbatim. `fix`: what `gh pr view <pr> --json headRefName,statusCheckRollup,mergeable,comments,reviews` prints, verbatim.>

<The plan made for this issue, verbatim. With none: "No plan: plan the change yourself.">

The repository's commands, from `.claude/github-flow.json`:

- validate: <each `validate` command>
- tier: <the `tier` command>
- land: <the `land` command>

<With no `.claude/github-flow.json`: "validate: the validation commands of AGENTS.md or CLAUDE.md. No tier and no land command: every pull request is `tier:human`.">

Your worktree may start from another branch than the pull request's base, `dev` when `origin/dev` exists. `issue`: branch from `origin/<base>` before the first edit. `fix`: `git fetch origin <head>`, then `git switch --detach FETCH_HEAD`; the first worker's worktree may still hold the branch, and git refuses a second checkout of it.

## Done means

`issue`: every box of the issue's *Done when* holds; the validate commands are green, and the app's e2e suite too when its `AGENTS.md` documents one and the change touches what it loads; a pull request URL exists; for a `tier:low` pull request, the land command printed its last line.

`fix`: the checks named above are green, each review comment is fixed or answered, the head is pushed with `git push origin HEAD:refs/heads/<head>`, the tier command ran again and the tier label follows it, and one comment is posted with `gh pr comment <pr> --body-file <file>`: first line `<!-- shift-fix -->`, then one line naming what changed.

## Keep going

When a step doesn't need anyone's input, keep going. Nobody reads a question: decide, and write the choice in the pull request's *Decisions*. A file outside the issue's *Out of scope* boundary goes back to its base state and is named in *Left open*. Stop only on:

- red after 2 red-green rounds: report `blocked`, the failing output verbatim, uncut, with no commit, push or pull request;
- a landing refusal: report its verdict line; the pull request stays open.

Always a `feature/<n>-<slug>` or `fix/<n>-<slug>` branch and a pull request, even for a typo: the inline lane is not yours. Never commit or push on `main` or `master`, never force-push a commit you did not write (`--force-with-lease` after a rebase, on this loop's branch only), never merge through GitHub, never add `land-ok`, never land a `tier:human` pull request, never write outside the worktree. Never take a label off, except `tier:low` when the tier rises to `tier:human`.

## Review, then land

`git:commit`, then `github-flow:pr`: with no user to ask, it settles the decisions, reviews the branch, writes the body, publishes, and sets the tier. Then, in `issue` mode:

- `tier:low`: run the land command from the worktree in the background, and wait for its last line with `Monitor`, up to 60 minutes. That line is the verdict.
- `tier:human`: nothing more. The human reads the pull request and says when to land it; that landing is not yours.

In `fix` mode the head you pushed waits for a later pass of the loop to land it.

## Report

```
PR          <url>
Tier        <low|human> <reason>
Landing     <the land command's last line, or: not mine, tier:human, or: fix, left to the loop>
Unconfirmed <what you could not confirm, and where you looked>
Received    <each instruction received after the spawn, applied or not>
```

A report without a pull request URL is `blocked`: the mode, the step, the failing output verbatim.
