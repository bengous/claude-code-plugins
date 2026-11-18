# Factory

A native software factory for a GitHub repository: cloud Claude sessions take the owner's issues and ship pull requests that land with no human in the loop.

## The loop

1. The owner labels his own issue `ready`.
2. `dispatch.yml` fires a claude.ai routine through its API trigger.
3. The routine's cloud session replaces `ready` with `in-progress`, implements the issue per `CLAUDE.md`, opens a pull request and enables auto-merge.
4. The merge queue squashes it once the required checks `test`, `review` and `owner-gate` pass and every review thread is resolved.

A session stopped by something outside its issue comments on the issue and labels it `blocked`. A pull request that touches a path of `CODEOWNERS` waits until the owner labels it `owner-ok`; a new push removes the label.

## Skills

| Skill | Invocation | What it does |
|-------|------------|--------------|
| `install` | `/factory:install [owner/name]` | Writes the factory's files into the current repository, versions the routine in `~/dotfiles/cloud/routines/`, and reports what the GitHub side still lacks. Asks the owner before every change outside the working tree. |
| `lead` | `/factory:lead [--max <n>] [--dry-run]` | One pass: checks the labels, has a red main repaired through a `main is red` issue, dispatches issues by labelling them `ready`, wakes the cloud session of a pull request that conflicts outside the merge queue, sends `blocked` issues back once their cause is gone, and returns a digest. Never merges and never adds `owner-ok`. |

## Templates

`templates/` holds the files of the proven trial, byte for byte, but for the trial's own path in `deep-review-paths` and three parameters:

| Parameter | Value |
|-----------|-------|
| `{{OWNER}}` | the owner's GitHub login |
| `{{REPO}}` | `owner/name` |
| `{{ROUTINE_ID}}` | the routine's `trig_…` id |

- `templates/repo/` lands at the same paths in the target repository: the `review`, `owner-gate` and `dispatch` workflows, `CODEOWNERS`, `deep-review-paths` and the `/pr-review` command.
- `templates/routine/prompt.md` is the routine's prompt.
- `templates/claude-md-sections.md` holds the `CLAUDE.md` sections the session and the review follow.

## Scripts

| Script | What it does |
|--------|--------------|
| `scripts/install.ts repo` | Renders `templates/repo/` into a working tree. Refuses to overwrite a file that differs unless `--force`; prints `wrote`, `identical` or `refused` per file. No GitHub call, no commit. |
| `scripts/install.ts prompt` | Renders the routine's `prompt.md` into a directory. |
| `scripts/check.ts --repo <owner/name>` | Reads, through `gh`, the labels, the default branch's ruleset (required checks, resolved threads, merge queue), the auto-merge setting and the secret names; one line per item, `ok` or `missing` with its fix. Exit 1 while one is missing. Never reads a secret's value. |

## Requirements

- `bun`
- `gh`, signed in as the owner
- The Claude GitHub App on the repository, a claude.ai routine with an API trigger, and the secrets `CLAUDE_CODE_OAUTH_TOKEN` and `ROUTINE_FIRE_TOKEN`

## License

MIT

## Author

Augustin BENGOLEA (bengous@protonmail.com)
