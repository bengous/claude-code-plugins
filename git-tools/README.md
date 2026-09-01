# Git Tools Plugin

Git and GitHub protocols for Claude Code: history rewriting without an editor, agent-ready issues, issue and PR triage, CI-gated merge.

## Skills

| Skill | Invocation | What it does |
|-------|------------|--------------|
| `issue` | `/git-tools:issue [number] <request>` | Writes or rewrites an issue as a prompt for another agent: Problem, Evidence, Hints, Done when, Out of scope. |
| `triage` | `/git-tools:triage [number\|url]` | Verifies an issue or PR against the current code, gives a one-word verdict with proof, then implements, keeps, or closes on your decision. |
| `await-merge` | `/git-tools:await-merge [pr]` | Watches the checks, merges by squash or rebase (never a merge commit), fast-forwards the local base branch. |
| `commit-close` | `/git-tools:commit-close [issue]` | Commits with a `Closes #N` trailer; the number comes from the argument or the branch name. |
| `linear-flow` | `/git-tools:linear-flow` | Doctrine and bootstrap for the dev-trunk/main-release fast-forward model. |
| `submodule-setup` | on request | Migrates branches to submodules with GitHub Actions sync. |

`issue` and `triage` invoke themselves when the request matches; the other four are manual.

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

## Retired

Branch and worktree cleanup lives in the `git-sweep` plugin. `bisect-ci`, `claude-review`, `handle`, and `issue-triage` are gone: the first sits in `archive/git-legacy/`, the second is covered by the built-in `/code-review`, the last two merged into `triage`.

## Requirements

- Git 2.23+ (`git switch`)
- GitHub CLI (`gh`) authenticated for issue and PR operations
- Clean working directory for rebase operations

## License

MIT

## Author

Augustin BENGOLEA (bengous@protonmail.com)
