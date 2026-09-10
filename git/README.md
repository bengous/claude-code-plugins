# Git Plugin

Local git for Claude Code, without an editor: commit, interactive rebase, squash. Nothing here reaches the network.

Its siblings own the rest: `github-flow` for anything through `gh`, `git-sweep` for branch and worktree cleanup, `git-worktree` for the `git-wt` helper, `repo-bootstrap` for one-shot repo setup.

## Skills

| Skill | Invocation | What it does |
|-------|------------|--------------|
| `commit` | `/git:commit [issue] [--no-close]` | Commits with a message that follows the repo's convention, and a `Closes #N` trailer when the argument or the branch name carries a number. |
| `rebase` | `/git:rebase <branch\|N\|X..Y>` | Interactive rebase with a visual plan and reworked messages, no editor. |
| `squash` | `/git:squash --pattern\|--hashes\|--range` | Squashes commits by pattern, hash list, or the last N, no editor. |

All three invoke themselves when the request matches.

### Closing an issue

The number comes from the argument first, then from the head of the branch name: `fix/123-popover` gives `Closes #123`. Neither, or `--no-close`: no trailer and no question. GitHub closes the issue when the commit reaches the default branch, so on any other branch the skill says so once.

Nothing staged: `commit` stages what forms one commit and leaves the rest. A file carrying a secret is never staged.

### `rebase`

Interactive git rebase with visual planning and reworked commit messages.

**Usage:**
```bash
/rebase 5               # The last 5 commits (HEAD~5)
/rebase main            # Every commit since the merge base with main
/rebase abc123..def456  # Every commit since abc123
/rebase continue        # After resolving a conflict
/rebase skip            # Drop the commit that conflicts
/rebase abort           # Undo the whole rebase
/rebase status          # Where a paused rebase stands
```

The branch form edits the commits made since the merge base. It does not move
the branch onto that branch's tip; `git rebase main` does that.

**Workflow:**

1. **Plan**: The backend lists the commits in the range, oldest first
2. **Choose Actions**: For each commit, answer:
   - `Pick`: Keep commit as-is
   - `Squash`: Combine with the commit above it
   - `Reword`: Change the commit message
   - `Drop`: Remove commit
3. **Plan**: The rendered plan is shown; no second question, the answers above are the plan
4. **Execute**: A backup branch is created, then the rebase runs with no editor

**Commit messages:**

Claude reads the commit and proposes reword or squash messages: the original,
a conventional-commit form when the history uses one, and a shorter subject.
You choose one or write your own — nothing is applied without that answer.
No separate model is called, and no suggestion is generated that you do not see.

**Safety:**

- Validates working directory is clean before starting
- Creates automatic backup branch (`rebase-backup-<branch>-<timestamp>`)
- Re-checks the plan against the branch at execution time and refuses a stale one
- Provides conflict resolution guidance if issues arise

**Example:**

```bash
/rebase 3

# Rebase plan — base 19b31bc
#
#   ✎ REWORD b0c153d feat: add parser
#            └─ message: feat(parser): add the expression parser
#   ⬆ SQUASH b63623d fix typo
#            └─ folded into the commit above
#   ✗ DROP   6d2e3bc chore: wip debug
#
# Summary: 0 pick, 1 squash, 1 reword, 1 drop
```

### `squash`

Squash commits by pattern, by hash list, or the last N, without opening an editor. See the skill's argument hint.

## Requirements

- Git 2.23+ (`git switch`)
- Clean working directory for rebase operations

## See also

`commit-push-pr` chains `commit` and then `pr`; it lives in `github-flow`, next to
the `pr` skill it calls.

## License

MIT

## Author

Augustin BENGOLEA (bengous@protonmail.com)
