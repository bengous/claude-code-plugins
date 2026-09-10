---
name: stacked-prs
description: >-
  Run a stack of pull requests on GitHub with `gh stack`: create, grow, submit,
  sync, land, repair, and cut a per-layer worktree with its handoff. Use when
  the user talks about stacked PRs, a stack or pile of PRs, `gh stack`, wants to
  split a large change into reviewable PRs that land together, or debugs a stack
  (empty PR "No commits between X and Y", "Needs rebase", local/GitHub
  divergence, a commit stuck under someone else's).
argument-hint: "[gh stack subcommand | symptom | worktree <branch> --base origin/<top>]"
allowed-tools: Bash(gh stack view:*), Bash(git worktree list:*)
---

# Stacked PRs with `gh stack`

A stack is a chain of branches above the trunk, one PR per branch, each PR based on the branch below it. Each PR shows only its own diff. Nothing merges before the end: the stack lands in one operation, bottom to top. Local tracking lives in `.git/gh-stack` (never versioned); the stack object lives on GitHub.

```
trunk
 └── layer-1      PR → trunk
      └── layer-2 PR → layer-1
           └── …  PR → previous layer
```

## The cycle

| Command | Effect |
|---|---|
| `gh stack init [branches…] [--base <trunk>]` | Creates the stack. Adopts existing branches, bottom to top. |
| `gh stack add <branch> -m "msg" [-A\|-u]` | Branches from the current top and commits what is staged. `-A` stages everything, untracked included; `-u` tracked files only. |
| `gh stack submit [--auto] [--open]` | Pushes everything, creates the missing PRs with the right base, updates existing bases, creates or updates the GitHub stack. |
| `gh stack push` | Pushes active branches, `--force-with-lease` branch by branch, not atomic: a rejected branch does not cancel the others. Skips merged and queued branches. Opens no PR. |
| `gh stack view [--short\|--json]` | State: `✓` merged, `◎` queued, `○` open, `⚠` needs rebase. |
| `gh stack sync [--prune]` | Fetches, reconciles with GitHub, fast-forwards the trunk, cascade-rebases, pushes atomically with `--force-with-lease`. Creates no PR. |
| `gh stack rebase [--downstack\|--upstack\|--no-trunk]` | Cascade rebase: each layer receives the tip of the previous one, after a trunk fetch unless `--no-trunk`. `--continue` after conflicts, `--abort` restores everything. |
| `gh stack merge [n] [--merge\|--squash\|--rebase] [--yes]` | Atomic landing, all or nothing, up to the chosen PR. With a merge queue, the stack joins the queue and lands when the queue processes it. |
| `gh stack checkout <n\|PR\|URL\|branch>` | Fetches a stack from GitHub, even one never tracked locally. |
| `gh stack modify` | TUI: drop, fold, insert, reorder, rename, applied together on confirm. Then `submit` when PRs are affected. |
| `gh stack link <n\|branch> <branch…>` | Stacks without local tracking; pushes the branches and opens the missing PRs. `n` first appends to the top of stack `n`. Two arguments minimum: it cannot create a one-PR stack. |
| `gh stack unstack [--local]` | Undoes the stack on GitHub, locally, or both. |
| `up`, `down`, `top`, `bottom`, `trunk`, `switch` | Navigation inside the stack. |

## The rules

1. One PR per layer, base = the layer below. The CLI sets it; never fix a base by hand with `gh pr edit`.
2. Branch from the top, never from the trunk nor from the stack base. Two layers cut side by side from the same base conflict on additive files (lockfile, changelog, docs index).
3. One checkout = one session. `add` changes the current branch; `sync` and `rebase` rewrite the SHAs of the whole stack; `sync --prune` moves the checkout when the current branch is merged. Two sessions on one checkout step on each other; parallel sessions take a worktree.
4. After every rebase (`sync`, `rebase`, `modify`): green verification gate, then a check of the produced content, not only of the absence of conflicts. Seen in practice: a `rebase --onto` that passed without conflict left a wrong config file, red gate on 60 files, no warning.
5. No code of the stack reaches the trunk before the landing. Otherwise the PR turns empty ("No commits between X and Y"): a PR shows the gap between its base and its head, and the code is on both sides.
6. `Closes #N` fires only on merge into the default branch. After `merge`, check that the issues closed; otherwise close them by hand.

## What the CLI does not decide

- Draft or ready. `submit --auto` (and every non-interactive terminal) creates new PRs as drafts. `--open` switches every existing PR to ready, not only the new ones: do not add it by reflex.
- Title and body. Without an editor they come from the commit message: write the commit body as a PR body.
- Merge method. `merge` remembers the last one used; set it once per repository and keep it.
- Local/GitHub divergence. `sync` resolves it only in an interactive terminal (remote as source of truth, or delete the GitHub stack then `submit`). Non-interactive, `sync` stops without pushing: intended, do not force.

## Repair

| Symptom | Move |
|---|---|
| `⚠ Needs rebase` | `gh stack rebase`, resolve conflicts then `--continue`; `--abort` puts everything back. |
| Empty PR, "No commits between" | The code is already on the trunk. Move the base under the commit to review, or remove it from the trunk. |
| Commit stuck under someone else's | `gh stack modify` (reorder, drop). Otherwise `git rebase --onto <base> <excluded-commit> <branch>`, then rule 4. |
| Stack created elsewhere (other machine, colleague) | `gh stack checkout <PR>`. |
| `local stack composition differs from remote` after a `link` | `gh stack link` writes GitHub only. `gh stack unstack --local`, then `gh stack checkout <n>` to re-import. Expected once per layer in the worktree flow, not an incident. |
| `switching to branch <b>: … already used by worktree` | A `gh stack` command that switches branches (`init`, `add`, `checkout`) cannot take a branch a worktree holds. Remove the worktree first: `git worktree remove --force <path>`, the branch survives. |
| A failed `gh stack` command that still wrote local tracking | Measured on `init`: the retry says `already exists in a stack` while `view` shows the stack. Read `gh stack view` before retrying; clear with `gh stack unstack --local`. |
| Merged branches lying around | `gh stack sync --prune`. |
| Branch rewritten by another session | `git fetch origin && git reset --hard origin/<that-branch>`. Never `origin/<trunk>`: the stack would vanish. |
| Any manual history rewrite | Save the ref first (`backup/<branch>-<sha>`), `--force-with-lease` only. |

## Parallel sessions: worktrees and handoffs

A handoff is one agent session dedicated to one layer, 40 to 90 lines, six fixed sections (template: `assets/handoff-template.md`): required reading, input required from the user, pre-flight, file scope, traps, deliverables. Handoffs live in a gitignored orchestration folder (convention `.gh/`), with a `README.md` that carries the session order and says which source wins on contradiction. That `README.md` is orchestrator-owned: it is one file symlinked into every worktree, so sessions report their state and the orchestrator writes the line. Two sessions ticking it at once race on the same file.

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/worktree-handoff.ts" <branch> --base origin/<top> [--link .env.local] [--install '<cmd>']
```

The script creates the branch and the worktree from the given base, symlinks the orchestration files (what the session writes there comes back to the main checkout), installs the dependencies from the lockfile, and refuses to run without `--base`, from a worktree, without a handoff, or on a branch already taken. Options: `--dir`, `--path`, `--handoff`, `--link` (repeatable), `--install`. The skill does not pre-approve the call: `--install` runs its value through the shell, so the permission rules of the session decide whether it prompts.

Pass `--install ''` only when the verification gate needs no dependencies. A worktree never shares the main checkout's `node_modules`, and the failure is misleading: measured on this repo, `bun run check` in a dependency-less worktree died on `GET https://registry.npmjs.org/tsgo - 404`, not on a missing dependency.

It prints one JSON object. On `ok: true`, report `worktree`, `linked`, `links_missing` when not empty, then print `launch` and `cleanup` verbatim. On `ok: false`, report `error` and `detail` and stop:

| `error` | Cause |
|---|---|
| `inside-a-worktree` | Run it from the main checkout. |
| `orchestration-dir-missing` | No `<dir>` folder; create it or pass `--dir`. |
| `handoff-missing` | `detail` lists the handoffs available under `<dir>/handoffs/`. |
| `base-not-found` | `detail` lists the ten most recent remote branches. |
| `branch-exists` | Reuse the existing worktree (`git worktree list`) or pick another name. |
| `worktree-path-exists` | `detail` is the path; remove it or pass `--path`. |
| `install-failed` | The install command's own output is above; fix it or pass `--install ''`. |
| `handoff-not-visible` | The symlink did not land; `detail` is the expected path inside the worktree. |

Inside the worktree, the session commits and pushes its branch, without `gh stack add`. Then, from the main checkout, remove the worktree first (`git worktree remove --force <path>`, the branch survives) and attach the layer:

| Layer | Move |
|---|---|
| The first one | No stack and no `n` exist yet, and `link` needs two arguments. `gh stack init <branch>` then `gh stack submit --auto`. The GitHub stack object appears only with the second PR. |
| Every next one | `gh stack link <n> <branch>` appends it to the top of stack `n` and opens its PR with the right base. |

`link` writes GitHub and never local tracking, so the local stack falls behind at every layer. Re-import before the next layer: `gh stack unstack --local`, then `gh stack checkout <n>`. That is the normal cycle of this flow, not a repair. Check `gh stack view` before cutting the next worktree.
