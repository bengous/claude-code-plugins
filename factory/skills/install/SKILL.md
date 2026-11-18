---
name: install
description: "Install the native software factory in the current repository: the review, owner-gate and dispatch workflows, CODEOWNERS, the review command, the CLAUDE.md sections and the claude.ai routine that turns a `ready` issue into a merged pull request; then report what the GitHub side still lacks. Use when the user asks to install, set up or add the factory to a repository, or to check a repository's factory setup."
argument-hint: "[owner/name]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/install.ts *), Bash(${CLAUDE_PLUGIN_ROOT}/scripts/check.ts *), Bash(gh repo view:*), Bash(gh api user:*), Read
---

# Install the factory

The factory runs with no human in the loop: the owner labels his own issue `ready`, `dispatch.yml` fires a claude.ai routine, a cloud session implements the issue and opens a pull request with auto-merge on, and the merge queue lands it once `test`, `review` and `owner-gate` pass and every thread is resolved. This skill puts the files in place and reports the rest; the owner decides each change outside the working tree.

## Ask before

Ask the owner, in the session, before each of these, and do it only on a yes:

- creating or changing the routine, and writing under `~/dotfiles`;
- creating a label, a ruleset, or changing a repository setting;
- setting a secret. A secret value never passes through you: the owner types it into `gh secret set` in his own terminal.

Writing into this repository's working tree needs no ask: `install.ts` refuses to overwrite a file that differs, and git undoes the rest.

## 1. Parameters

- `REPO`: `$ARGUMENTS` when given, else `gh repo view --json nameWithOwner --jq .nameWithOwner`.
- `OWNER`: the login of the human who labels issues `ready` and pull requests `owner-ok`. Propose `gh api user --jq .login` and have the owner confirm it: the workflows trust that login alone.
- `BRANCH`: the default branch, the base of every pull request: `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`.
- `ROUTINE_ID`: the `trig_…` id of the routine, known once step 2 created it.

Each `install.ts` subject takes exactly the flags shown below and refuses any other.

## 2. Routine

Each routine is versioned in `~/dotfiles/cloud/routines/<name>/` first, then created to match, then checked. Name it `<repo name>-worker`.

1. Write its prompt:

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/scripts/install.ts" prompt --owner <OWNER> --repo <REPO> --branch <BRANCH> --dir ~/dotfiles/cloud/routines/<name>
   ```

2. Write `routine.json` beside it, on the model of an existing routine there: `name` `<repo name>: issue to PR`, `enabled` true, no cron, `model` `claude-opus-5-5`, `effort_level` `medium`, `allowed_tools` `["Bash", "Read", "Write", "Edit", "Glob", "Grep"]`, `sources` `["<REPO>"]`, `persist_session` false, the cloud environment the owner names. Its `id` is filled once the routine exists.
3. Create the routine from these two files and write its `trig_…` id into `routine.json`.
4. Run `bun run routines:check` in `~/dotfiles`: it must exit 0.

The routine has no trigger yet, and only the owner can add one: on the routine's page on claude.ai, *Edit*, the *Trigger* row, **+**, *API*, *Generate token*. The token is shown once. Ask him to do it, then to run `gh secret set ROUTINE_FIRE_TOKEN --repo <REPO>` and paste it there.

## 3. Files

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/install.ts" repo --owner <OWNER> --routine <ROUTINE_ID> --branch <BRANCH>
```

Run it from the repository's root. Each line is `wrote`, `identical`, `overwrote` or `refused`. A `refused` file differs from the template: show the owner the difference and run again with `--force`, which prints `overwrote`, only on his yes. A file the owner adapted on purpose stays refused on every later run; that is expected.

Then, with the owner:

- `.github/deep-review-paths` lists `/.github/` alone. Add this repository's sensitive paths, one prefix per line: the review reads every caller and test of a change there, at a higher effort.
- Merge the sections of `${CLAUDE_PLUGIN_ROOT}/templates/claude-md-sections.md` into `CLAUDE.md`: the cloud session and the review both follow them. Write `<BRANCH>` where the file says `{{BRANCH}}`. Its test command and its *Code* rules are the trial's: adapt them to this repository and show the owner the result.
- The ruleset will require a check named `test`: a CI job named `test` that runs on `pull_request` and `merge_group`. Say so if the repository has none.

Commit the files on a branch and have them reach the default branch before step 4's ruleset requires the checks: `owner-gate.yml` runs as it is on the default branch, so a pull request opened before it lands waits for a check that never reports.

## 4. GitHub side

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/check.ts" --repo <REPO>
```

One line per item, `ok` or `missing` with the `gh` command that fixes it; exit 1 while one is missing. A secret marked `not visible` means this token cannot list secrets: ask the owner whether it is set. For each missing item, tell the owner what it does and ask before running its fix:

- **Labels** `ready`, `in-progress`, `blocked`, `owner-ok`: the fix creates the label.
- **Ruleset**: the checks, resolved threads and merge queue live in one ruleset on the default branch. The fix reads a `ruleset.json` you write outside the repository. With `PUT`, a ruleset exists: `PUT` replaces all its rules, so read it first with `gh api repos/<REPO>/rulesets/<id>`, keep its rules and add the missing ones. The proven body:

  ```json
  {
    "name": "main",
    "target": "branch",
    "enforcement": "active",
    "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
    "bypass_actors": [],
    "rules": [
      { "type": "deletion" },
      { "type": "non_fast_forward" },
      { "type": "pull_request", "parameters": { "required_approving_review_count": 0, "dismiss_stale_reviews_on_push": true, "required_reviewers": [], "require_code_owner_review": true, "dismissal_restriction": { "enabled": false, "allowed_actors": [] }, "require_last_push_approval": false, "required_review_thread_resolution": true, "require_extra_approval_for_unattributed_changes": true, "allowed_merge_methods": ["squash"] } },
      { "type": "required_status_checks", "parameters": { "strict_required_status_checks_policy": false, "do_not_enforce_on_create": false, "required_status_checks": [{ "context": "test" }, { "context": "review" }, { "context": "owner-gate" }] } },
      { "type": "merge_queue", "parameters": { "merge_method": "SQUASH", "max_entries_to_build": 5, "min_entries_to_merge": 1, "max_entries_to_merge": 5, "min_entries_to_merge_wait_minutes": 0, "grouping_strategy": "ALLGREEN", "check_response_timeout_minutes": 30 } }
    ]
  }
  ```

- **Auto-merge**: the cloud session enables it on its pull request; the fix allows it on the repository.
- **`CLAUDE_CODE_OAUTH_TOKEN`**: the review workflow's token. The owner generates it with `claude setup-token` and sets it with the printed `gh secret set` command, in his terminal.
- **`ROUTINE_FIRE_TOKEN`**: step 2.

`check.ts` does not see two things the factory also needs: the Claude GitHub App installed on the repository, through which the cloud session pushes and the review comments; and the routine itself, which step 2 checks. Ask the owner to confirm the App.

Run `check.ts` again after the fixes; it exits 0 once the GitHub side is complete.

## Report

What `install.ts` wrote, what it refused and what the owner decided; the routine's directory and id; each `check.ts` line still `missing` and what it waits for. The factory is ready when `check.ts` exits 0, the files are on the default branch and the App is installed.
