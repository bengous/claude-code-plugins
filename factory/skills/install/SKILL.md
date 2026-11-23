---
name: install
description: "Install the native software factory in the current repository: the dispatch, review, owner-gate, conflict and trunk-red workflows, the tier classifier and its rules, CODEOWNERS, the review command, the verify skill and its hook, the CLAUDE.md sections and the claude.ai routine that turns a `ready` issue into a merged pull request; then report what the GitHub side still lacks. Use when the user asks to install, set up or add the factory to a repository, or to check a repository's factory setup."
argument-hint: "[owner/name]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/install.ts *), Bash(${CLAUDE_PLUGIN_ROOT}/scripts/check.ts *), Bash(bun .github/factory/tier.ts replay *), Bash(claude -p *), Bash(mktemp -d), Bash(gh repo view:*), Bash(gh api user:*), Bash(gh pr list:*), Bash(gh pr diff:*), Bash(gh workflow list:*), Read
---

# Install the factory

The factory runs with no human in the loop. The owner labels his own issue `ready`; `dispatch.yml` fires a claude.ai routine; a cloud session implements the issue, runs the repository's `verify` skill and opens a pull request with auto-merge on. The `owner-gate` check gives the change a tier: `low` lands once `test` and `review` are green, `human` waits for the owner's `human-approved` label. The review stops a pull request at its third failed round or at a force-push, `conflict.yml` tells a session its pull request conflicts, and `trunk-red.yml` has a red default branch repaired.

Run it from a checkout of `<REPO>`. The factory's pull requests target the repository's default branch: a repository whose working trunk is not its default branch is not supported.

## Ask before

Ask the owner, in the session, before each of these, and do it only on a yes:

- creating or changing the routine, and writing under `~/dotfiles`;
- creating a label, a ruleset, or changing a repository setting;
- setting a secret. A secret value never passes through you: the owner types it into `gh secret set` in his own terminal.

Writing into this repository's working tree needs no ask: `install.ts` refuses to overwrite a file that differs, and git undoes the rest.

## 1. Parameters

- `REPO`: `$ARGUMENTS` when given, else `gh repo view --json nameWithOwner --jq .nameWithOwner`. It must be the repository of the current checkout.
- `OWNER`: the login of the human who labels issues `ready` and pull requests `human-approved`. Propose `gh api user --jq .login` and have the owner confirm it: the workflows trust that login alone.
- `BRANCH`: the default branch, the base of every pull request: `gh repo view <REPO> --json defaultBranchRef --jq .defaultBranchRef.name`.
- `CI`: the name of the repository's CI workflow, its `name:` line, which `trunk-red.yml` listens to. `gh workflow list --repo <REPO>` lists the names; ask the owner which one tests the code. The ruleset requires a check named `test`: that workflow needs a job that reports it, its `name:` `test` or its id `test` with no `name:`, and no matrix, which reports `test (…)`. It runs on `pull_request`, on `push` to `<BRANCH>`, and on `merge_group` where the repository has a merge queue, with no `paths` or `paths-ignore` filter: a filtered change never gets the check. Say so now if it has none; step 6 reports it.
- `ROUTINE_ID`: the `trig_…` id of the routine, known once step 2 created it.

## 2. Routine

1. Ask the owner to give the Claude GitHub App access to `<REPO>` first, at <https://github.com/apps/claude>, and to confirm it. A routine created before that cannot read the repository, and its cloud session cannot push.
2. Render the prompt into a scratch directory: `mktemp -d` prints one, then

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/scripts/install.ts" prompt --owner <OWNER> --repo <REPO> --branch <BRANCH> --dir <scratch dir>
   ```

3. Create the routine from that prompt with the `RemoteTrigger` tool, action `create` (the owner's own way is `/schedule`): `name` `<repo name>: issue to PR`, `enabled` true, no cron, `model` `claude-opus-5-5`, `effort_level` `medium`, `allowed_tools` `["Bash", "Read", "Write", "Edit", "Glob", "Grep"]`, `sources` `["<REPO>"]`, `persist_session` false, the cloud environment the owner names, and `clear_mcp_connections` true: a routine created with no connector named gets every connector of the owner's account, mail and drive included, and the Worker needs none.
4. Only once the routine exists, version it: write `~/dotfiles/cloud/routines/<repo name>-worker/prompt.md` by running the same `install.ts prompt` command again with `--dir ~/dotfiles/cloud/routines/<repo name>-worker`, and `routine.json` beside it on the model of an existing routine there, with the `trig_…` id. Add the folder's name to the list `scripts/routines/routine.test.ts` expects there. Then `bun run routines:check` in `~/dotfiles` must exit 0.

The routine has no trigger yet, and only the owner can add one: on the routine's page on claude.ai, *Edit*, the *Trigger* row, **+**, *API*, *Generate token*. The token is shown once. Ask him to do it, then to run `gh secret set ROUTINE_FIRE_TOKEN --repo <REPO>` and paste it there.

## 3. Files

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/install.ts" repo --owner <OWNER> --routine <ROUTINE_ID> --branch <BRANCH> --ci <CI>
```

Run it from the repository's root. Each file prints `wrote`, `identical`, `overwrote` or `refused`; `.claude/settings.json` prints `merged` or `identical`, since the two verify hooks are added to what the file already holds. A `refused` file differs from the template: show the owner the difference and run again with `--force` only on his yes. A file adapted on purpose, the tier files of step 5 among them, stays refused on every later run; that is expected.

Then, with the owner:

- `.github/deep-review-paths` lists `/.github/` alone. Add this repository's sensitive paths, one prefix per line: the review reads every caller and test of a change there, at a higher effort.
- Merge the sections of `${CLAUDE_PLUGIN_ROOT}/templates/claude-md-sections.md` into `CLAUDE.md`: the cloud session and the review both follow them. Write `<BRANCH>` where the file says `{{BRANCH}}`. Its test command and its *Code* rules are the trial's: adapt them to this repository and show the owner the result.

## 4. Verify recipe

The cloud session verifies its change with the repository's own `verify` skill, and a hook sends it back when it forgets. Record that skill by running the bundled `/verify` once, from the repository's root:

```bash
claude -p "/verify the last commit, and record the recipe that worked in .claude/skills/verify/SKILL.md at the repository root, as you do for a project with no recorded recipe"
```

Read `.claude/skills/verify/SKILL.md` and show it to the owner. It must say how to build and exercise a change in this repository, and it must not carry `disable-model-invocation`: the session runs it by itself. When the run wrote no file, write one from what the run printed: the command that launches the program, an input that exercises it, what a good and a bad result look like.

## 5. Tier

`install.ts` wrote a generic floor and a generic question. Write this repository's own, then show both files to the owner:

- `.github/factory/tier.json`: `lineCap`, the lines changed past which a change waits for the owner, and `humanPaths`, globs from the repository root that always wait for him. `CODEOWNERS` already holds `.github/`, `.claude/` and `CLAUDE.md`. Add what configures the checks or what no check covers here: package manifests and lockfiles, the test runner's and the build's configuration, migrations, deploy and infrastructure files. Read the repository to find them.
- `.github/factory/tier-prompt.md`: keep its structure and its last three paragraphs. Rewrite the first paragraph to say what this repository is and what its code can touch, and the list under "What a revert cannot undo" to name what a run of this code writes outside the repository: its database, the services it calls, what it publishes or deletes. Name the test command that catches a mistake.

Then the cases, right away, with the owner. Tell him what skipping this step costs: without validated cases the floor runs alone, every change that passes it is `human`, and nothing lands without him.

1. Read the merged pull requests: `gh pr list --repo <REPO> --state merged --limit 60 --json number,title,additions,deletions,files`, and `gh pr diff <n> --repo <REPO>` for the ones you are unsure of. A repository with no merged pull request has no case to build: say so, leave `tier-cases.json` as it is, and go to step 6.
2. Propose `.github/factory/tier-cases.json`: some twenty cases, each `{"name", "expected", "pr"}` with the tier you expect from the diff alone, `low` or `human`. Where history holds no change a revert cannot undo, no deleted or weakened test, no behaviour changed without a test, add each as `{"name", "expected": "human", "diff"}` with a unified diff written against this repository's code. Leave `model` and `prompt` null. The owner confirms the list.
3. Replay them, each case three times:

   ```bash
   bun .github/factory/tier.ts replay --repo <REPO>
   ```

   A false `low` means the question is too loose: tighten `tier-prompt.md` and replay. A run with no false `low` and no failure ends with `validated`; run it once more with `--record`, which writes the model and the prompt's digest into `tier-cases.json`. Any later edit of `tier-prompt.md` needs a new `--record`: the gate answers `human` for a prompt its cases did not validate.

## 6. Land, then the GitHub side

Commit the files on a branch and have them reach `<BRANCH>`. On a first install, do it before the ruleset requires the checks: `owner-gate.yml` runs as it is on `<BRANCH>`, so a pull request opened before it lands waits for a check that never reports. On a repository that already runs an older factory, the pull request is held by the gate that is on `<BRANCH>`: the owner approves it with the label that gate reads, and deletes that label once the new gate, which reads `human-approved`, has landed. There, land `.github/workflows/review.yml` in a pull request of its own, after the others: the review cannot run on a pull request that changes it, and lets one through unreviewed only when every file it touches is a path of the `CODEOWNERS` on `<BRANCH>`, which lists `.github/` once the first pull request has landed.

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/check.ts" --repo <REPO>
```

One line per item, `ok` or `missing` with what fixes it; exit 1 while one is missing. A secret marked `not visible` means this token cannot list secrets: ask the owner whether it is set. For each missing item, tell the owner what it does and ask before running its fix:

- **Labels**: the fix creates the label. `ready`, `in-progress`, `blocked`, `needs-human`, `trunk-red`, `tier:low`, `tier:human` and `human-approved` are the factory's states.
- **Files**, and the hooks of `.claude/settings.json`: steps 3 to 5, then land them. A file that exists but says the wrong thing is an older or adapted version: `owner-gate.yml` must run `tier.ts` and read `human-approved`, `review.yml` name `needs-human`, `CODEOWNERS` list `/.github/`, `/.claude/` and `/CLAUDE.md`, the verify skill carry no `disable-model-invocation: true`, and `CLAUDE.md` name `needs-human` and `human-approved`.
- **CI workflow**: the workflow `trunk-red.yml` names must exist and hold a job that reports the check `test`, on pull requests and on pushes to `<BRANCH>`, with no paths filter.
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

  Leave the `merge_queue` rule out where GitHub offers no merge queue: it offers one in a public repository of an organization, and in a private one under GitHub Enterprise Cloud. `check.ts` reports a default branch without one and does not count it missing.

  A bypass actor on a ruleset of `<BRANCH>` merges past the checks: the fix empties `bypass_actors`. `check.ts` reports them `not visible` when this token may not read them: ask the owner to look in the ruleset's settings.

- **Auto-merge**: the cloud session enables it on its pull request; the fix allows it on the repository.
- **Squash merge**: the ruleset allows only squash merges, so the repository must allow them.
- **GitHub Actions**: it must be enabled and allow every action, or the three the workflows use: `actions/checkout`, `oven-sh/setup-bun` and `anthropics/claude-code-action`. With selected actions only, `check.ts` prints the line `ok`: have the owner check that those three are allowed.
- **`CLAUDE_CODE_OAUTH_TOKEN`**: the token of the review and of the tier classifier. The owner generates it with `claude setup-token` and pastes it into `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo <REPO>`, in his terminal.
- **`ROUTINE_FIRE_TOKEN`**: step 2.

On a private repository `check.ts` also prints what a workflow's token may do by default. The factory's workflows declare the permissions they need. A job of the repository's own that calls the API without declaring any, such as a CI step that lists pull requests, fails there: tell the owner which of his workflows declare none.

`check.ts` does not see the Claude GitHub App on the repository, nor the routine: steps 2 covers both.

Run `check.ts` again after the fixes; it exits 0 once everything is in place.

## Report

What `install.ts` wrote, merged and refused, and what the owner decided; the routine's directory and id; the verify recipe and the tier files shown to the owner; whether the cases are validated or the floor runs alone; each `check.ts` line still `missing` and what it waits for. The factory is ready when `check.ts` exits 0 and the App has access.
