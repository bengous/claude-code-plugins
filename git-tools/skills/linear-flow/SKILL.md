---
name: linear-flow
description: This skill should be used when the user asks to "set up linear flow", "apply the linear workflow", "land this branch", "release to main", "push dev to main", asks how work should reach dev or main in a repo using this model, or wants a repo migrated to the dev-trunk/main-release fast-forward model with no merge commits.
---

# Linear Flow

Doctrine for repos on the linear model. One linear signed history. `dev` is the working trunk. `main` is the release channel consumers use: a delayed pointer on `dev`'s history, moved only by fast-forward. No merge commits anywhere; the server refuses them (`required_linear_history`).

```
dev   ──●──●──●──●──●──●──●──►   the only line of history
                    ↑
main ───────────────┘            release = git push origin dev:main
```

`main` is always an ancestor of `dev`. If a repo has no release channel, `main` alone is the trunk and every `dev` rule below applies to `main`.

## Rules

1. **Threshold.** Small single-concern change: commit directly on `dev`, atomic and curated. Big work (large feature, large skill), several concerns, or parallel agents: branch or PR stack targeting `dev`.
2. **Landing.** Rebase the branch on `dev`, then `git push origin <branch>:dev`. The identical SHAs reaching the base marks the PR merged. Never use the GitHub merge button: server-side merge or rebase re-creates commits unsigned and breaks `required_signatures`.
3. **Release.** `git push origin dev:main` when `dev` has soaked long enough. Nothing else ever touches `main`.
4. **Force-push.** Only on feature branches, only `--force-with-lease`. Never on `dev` or `main`.
5. **Review.** Agents review other agents' PRs in fresh context. The human reviews contracts and runs tests at the end of a chantier and before each release; the human does not re-read details.
6. **History is authored.** Curate commits before landing: atomic, conventional messages. Messy exploration gets squashed or reworded during the pre-land rebase, not after.

## Recovery

| Symptom | Fix |
|---|---|
| Push to `dev`/`main` rejected non-fast-forward | Rebase on the current remote tip, push again. Never force. |
| Push rejected `required_linear_history` | A merge commit slipped in; rebase to flatten it, push again. |
| PR not marked merged after landing | The pushed SHAs differ from the PR head. Push the rebased branch to the PR first, then push it to `dev`. |
| `main` no longer ancestor of `dev` | Someone moved `main` off the line. Fast-forward the lagging ref onto the other; if truly diverged, stop and ask the user which line wins. |
| `git pull` refused on `dev` | Pull with rebase; the ruleset rejects merge commits from pulls too. |

## Setup

To migrate or bootstrap a repo onto this model, follow `references/setup.md`: rulesets, CI ancestor guard, CLAUDE.md section, initial sync, verification.
