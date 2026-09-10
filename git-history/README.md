# Git History Plugin

Local history for Claude Code, without an editor: commit, commit closing an issue, interactive rebase, squash.

## Skills

| Skill | Invocation | What it does |
|-------|------------|--------------|
| `commit` | `/git-history:commit [subject hint]` | Commits what is staged with a message that follows the repo's convention. |
| `commit-close` | `/git-history:commit-close [issue]` | Commits with a `Closes #N` trailer; the number comes from the argument or the branch name. |

Both are manual.

## Commands

### `/rebase`

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
3. **Review Plan**: The rendered plan is shown before anything runs
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
#
# Run this rebase? [Run / Cancel]
```

### `/squash`

Squash commits by pattern, by hash list, or the last N, without opening an editor. See the command's argument hint.

## Requirements

- Git 2.23+ (`git switch`)
- Clean working directory for rebase operations

## License

MIT

## Author

Augustin BENGOLEA (bengous@protonmail.com)
