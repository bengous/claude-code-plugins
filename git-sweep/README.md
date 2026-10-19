# Git Sweep

Git branch and worktree cleanup that deletes only what it can prove is already in the base, and says why it kept the rest.

## Skills

| Skill | Invocation | What it does |
|-------|------------|--------------|
| `git-sweep` | `/git-sweep [base]` | Audits local and remote branches and worktrees, shows each category with its proof, and asks before deleting anything. Typed by the user only. |
| `auto-sweep` | `git-sweep:auto-sweep [--dry-run] [--base <branch>]` | Deletes, with no prompt, the local branches it proves and the agent worktrees standing on them, and archives abandoned agent branches. Claude runs it on its own at the end of a session or after a landing. |

`auto-sweep` is model-invocable although it deletes unasked, because every deletion has an undo or loses nothing: a proven branch's content is in the base, an archived branch restores, and a removed worktree loses only the ignored paths a checkout regenerates.

## Proofs

A branch is deleted only with one of these, from `scripts/proofs.ts`:

- `ancestry`: its tip is reachable from the base; nothing is lost.
- `no-merge-delta`: merging it into the base would change no file; the content is there, the intermediate commits are not.
- `merged-pr`: a merged GitHub pull request, landed in the base, holds every commit of the branch. Needs `gh`.

A patch-id match is not a proof: it would call contained a squash the base later reverted.

## `auto-sweep`

`scripts/auto-sweep.ts` runs the audit and the apply of `/git-sweep` in one pass, with no question. It judges against `--base`, else `sweep.base`, else `dev` or `develop`, else origin/HEAD, then main, master or trunk. `--dry-run` prints the same summary and changes nothing.

An agent worktree is a direct child of `.claude/worktrees/` whose name starts with `agent-`, where Claude Code puts its subagents' worktrees; the path counts, not the branch name, since agents rename their branch. An agent branch is one named with `sweep.agentPrefix` (default `worktree-agent-`), or checked out only in an agent worktree.

What it deletes:

- every local branch with a proof, unless a worktree it leaves stands on it;
- a clean agent worktree on a proven branch, with the branch, when every ignored path it holds is one `DISPOSABLE_IGNORED` names: `node_modules/` and `__pycache__/` at any depth, `.stryker-tmp/`, `vellum/test-results/`, `flaky-reports/`, and the `tsconfig.json` and `.claude-plugin/types/` Claude Code writes at a plugin's root. The summary names them;
- the registration of an agent worktree whose directory is gone.

What it archives: an unproven agent branch, with no worktree or a clean agent worktree, whose last pull request was closed unmerged and whose last commit are both 14 days old or more (`CLOSED_PR_GRACE_DAYS`), or that has no pull request and no commit for 30 days (`NO_PR_IDLE_DAYS`). Without an `origin` remote no branch has a pull request; with one `gh` cannot read, nothing is archived. The branch tip is written to `refs/archive/<branch>` first, then the branch and its worktree go. Restore one with:

```bash
git branch <branch> refs/archive/<branch>
```

`git for-each-ref refs/archive/` lists them. A failed deletion drops the archive ref it just wrote. An archive ref never expires: `git update-ref -d refs/archive/<branch>` drops one.

What it keeps, each with its reason in the summary:

- the base, the protected branches (main, master, trunk, dev, develop, `sweep.protect`) and the current branch;
- a worktree with uncommitted or untracked changes, a locked one, and one holding any other ignored path, named in the summary: removal would destroy it for good, and a `plans/` there may be the only copy of a plan;
- a named worktree, `.claude/worktrees/<name>` without the `agent-` prefix (EnterWorktree's): a live session may stand in one, and nothing locks it. Like any worktree outside `.claude/worktrees/agent-*`, it stays with its branch, listed as not swept;
- the branch Claude Code named after a locked agent worktree (`worktree-agent-<id>`), while that agent runs;
- a backup branch not contained by ancestry, an unproven branch that is not an agent's, and an agent branch with an open or merged pull request, or whose pull requests `gh` cannot read;
- every remote branch and tracking ref: `/git-sweep` handles those, with the user.

Exit 0 when every operation went through, 1 when the audit or an operation failed, 2 on a bad argument.

## Configuration (git config, all optional)

- `sweep.base`: the base to judge against when none is given
- `sweep.protect` (multi-valued): extra branches never proposed for deletion
- `sweep.unprotect` (multi-valued): names lifted from the default protected set; the base stays protected
- `sweep.agentPrefix` / `sweep.backupPrefix`: classification prefixes (defaults `worktree-agent-`, `backup/`; they must not overlap)
- `sweep.maxAgeDays`: age bound for the containment test (default 180)

## Requirements

- Git with `git merge-tree --write-tree`
- `bun`
- `gh`, optional, for the `merged-pr` proof and the pull request states

## License

MIT

## Author

Augustin BENGOLEA (bengous@protonmail.com)
