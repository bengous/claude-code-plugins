# GitHub Flow Plugin

GitHub lifecycle for Claude Code through `gh`: agent-ready issues, review-ready PRs, issue and PR triage, CI-gated merge.

## Skills

| Skill | Invocation | What it does |
|-------|------------|--------------|
| `issue` | `/github-flow:issue [number] <request>` | Writes or rewrites an issue as a prompt for another agent: Problem, Evidence, Hints, Done when, Out of scope. |
| `pr` | `/github-flow:pr [image.png#alt ...] [notes]` | Pushes the branch and opens or updates its PR with a body sized to the diff; images go up through `gh --attach`. |
| `triage` | `/github-flow:triage [number\|url]` | Verifies an issue or PR against the current code, gives a one-word verdict with proof, then implements, keeps, or closes on your decision. |
| `await-merge` | `/github-flow:await-merge [pr]` | Watches the checks, merges by squash or rebase (never a merge commit), fast-forwards the local base branch. |

`issue`, `pr`, and `triage` invoke themselves when the request matches; `await-merge` is manual.

### PR shape

The body is a review brief for another agent. Its sections grow with the diff:

| Size | Threshold | Sections |
|---|---|---|
| standard | otherwise | Why, What, Ask, Checks, Left open |
| large | ≥ 10 files, ≥ 300 lines, or a shared module | Why, Files that matter, The code that matters, Ask, Checks, Left open |

`Closes #N.` opens the body when the branch or a commit names an issue. A visual change carries a Before/After pair in Why: the agent captures both states with the session's browser tool when none is given, and `gh pr create --attach './before.png#alt'` uploads them; the alt text names what the reader sees. Ask tells the reviewer what to decide and what the author could not run. Checks list what ran with its numbers, never a check that did not run.

### Issue shape

```markdown
## Problem      what is observed and what is wanted, no solution
## Evidence     one fact per bullet, each anchored: path:line + symbol, or a commit
## Hints        where to start, traps, boundaries; suggestions, never a plan
## Done when    observable checkboxes, including the project's validation command
## Out of scope what not to touch on the way (omitted when empty)
```

The reader is a different agent in a fresh session. The issue proves the problem; the reader plans.

### Triage verdicts

| Issue | PR |
|---|---|
| `valid`, `fixed`, `outdated`, `duplicate`, `unclear` | `mergeable`, `needs-rebase`, `superseded`, `stale`, `unclear` |

Close comments are one to three sentences of fact: what was verified and the commit, issue, or PR that settles it.

## Requirements

- GitHub CLI (`gh`) authenticated

## License

MIT

## Author

Augustin BENGOLEA (bengous@protonmail.com)
