# Factory

A native software factory for a GitHub repository: cloud Claude sessions take the owner's issues and ship pull requests that land with no human in the loop.

## The loop

1. The owner labels his own issue `ready`.
2. `dispatch.yml` fires a claude.ai routine through its API trigger.
3. The routine's cloud session replaces `ready` with `in-progress`, implements the issue per `CLAUDE.md`, opens a pull request and enables auto-merge.
4. The merge queue squashes it once the required checks `test`, `review` and `owner-gate` pass and every review thread is resolved.

A session stopped by something outside its issue comments on the issue and labels it `blocked`. A pull request that touches a path of `CODEOWNERS` waits until the owner labels it `owner-ok`; a new push removes the label.

The factory's pull requests target the repository's default branch, and `check.ts` reads that branch's ruleset. A repository whose working trunk is not its default branch is not supported by this version.

## Skills

| Skill | Invocation | What it does |
|-------|------------|--------------|
| `install` | `/factory:install [owner/name]` | Writes the factory's files into the current repository, versions the routine in `~/dotfiles/cloud/routines/`, and reports what the GitHub side still lacks. Asks the owner before every change outside the working tree. |
| `lead` | `/factory:lead [--max <n>] [--dry-run]` | One pass: checks the labels, has a red main repaired through a `main is red` issue, dispatches issues by labelling them `ready`, wakes the cloud session of a pull request that conflicts with the default branch, sends `blocked` issues back once their cause is gone, and returns a digest. Never merges and never adds `owner-ok`. |

## Templates

`templates/` holds the files of the proven trial, byte for byte, but for the trial's own path in `deep-review-paths` and four parameters:

| Parameter | Flag | Value |
|-----------|------|-------|
| `{{OWNER}}` | `--owner` | the owner's GitHub login |
| `{{REPO}}` | `--repo` | `owner/name` |
| `{{ROUTINE_ID}}` | `--routine` | the routine's `trig_…` id |
| `{{BRANCH}}` | `--branch` | the repository's default branch, a git branch name |

- `templates/repo/` lands at the same paths in the target repository: the `review`, `owner-gate` and `dispatch` workflows, `CODEOWNERS`, `deep-review-paths` and the `/pr-review` command.
- `templates/routine/prompt.md` is the routine's prompt.
- `templates/claude-md-sections.md` holds the `CLAUDE.md` sections the session and the review follow.

A template changes only after the same change has run in the trial, and is then copied from it by hand. A package rule in `renovate.json` turns Renovate off under `templates/`, so an action or dependency update reaches the templates through the trial alone.

## Scripts

| Script | What it does |
|--------|--------------|
| `scripts/install.ts repo --owner --routine --branch [--target] [--force]` | Renders `templates/repo/` into a working tree. Refuses to overwrite a file that differs unless `--force`; prints `wrote`, `identical`, `overwrote` or `refused` per file. No GitHub call, no commit. |
| `scripts/install.ts prompt --owner --repo --branch --dir [--force]` | Renders the routine's `prompt.md` into a directory. |
| `scripts/check.ts --repo <owner/name>` | Reads, through `gh`, the labels, the default branch's ruleset (required checks, resolved threads, merge queue), the auto-merge setting and the secret names; one line per item, `ok` or `missing` with its fix, a secret the token cannot list marked `not visible`. Exit 1 while one is missing. Never reads a secret's value. |

Each subject of `install.ts` takes exactly the parameter flags its templates name and refuses any other, and an empty path.

## Requirements

- `bun`
- `gh`, signed in as the owner
- The Claude GitHub App on the repository, a claude.ai routine with an API trigger, and the secrets `CLAUDE_CODE_OAUTH_TOKEN` and `ROUTINE_FIRE_TOKEN`
- A CI job named `test` that runs on `pull_request`, `merge_group` and `push` to the default branch
- The owner's routine convention, which the install skill follows: each routine is versioned in `~/dotfiles/cloud/routines/<name>/` (`routine.json`, `prompt.md`), created to match, and `bun run routines:check` in `~/dotfiles` exits 0

## License

MIT

## Author

Augustin BENGOLEA (bengous@protonmail.com)
