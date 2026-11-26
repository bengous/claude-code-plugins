---
name: install
description: "Install the native software factory in the current repository: the dispatch, review, owner-gate, conflict, trunk-red and unclaim workflows, the tier classifier and its rules, CODEOWNERS, the review command, the pr and issue skills and their checks, the verify skill and its hook, the declaration of its cloud environment, the CLAUDE.md sections and the claude.ai routine that turns a `ready` issue into a merged pull request; then report what the GitHub side still lacks. Use when the user asks to install, set up or add the factory to a repository, or to check a repository's factory setup."
argument-hint: "[owner/name]"
disable-model-invocation: true
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/install.ts *), Bash(${CLAUDE_PLUGIN_ROOT}/scripts/check.ts *), Bash(bun .github/factory/tier.ts replay *), Bash(claude -p *), Bash(mktemp -d), Bash(gh repo view:*), Bash(gh api user:*), Bash(gh pr list:*), Bash(gh pr diff:*), Bash(gh workflow list:*), Bash(mise -C .github/factory lock:*), Bash(bun run --cwd ~/dotfiles routines:check), Read
---

# Install the factory

The factory runs with no human in the loop. The owner labels his own issue `ready`; `dispatch.yml` fires a claude.ai routine; a cloud session implements the issue, runs the repository's `verify` skill and opens a pull request with auto-merge on. The `owner-gate` check gives the change a tier: `low` lands once `test` and `review` are green, `human` waits for the owner's `human-approved` label. The review stops a pull request at its third failed round or at a force-push, `conflict.yml` tells a session its pull request conflicts, `trunk-red.yml` has a red default branch repaired and closes its repair issue once the branch is green again, and `unclaim.yml` takes `in-progress` off an issue its merged pull request closed.

Run it from a checkout of `<REPO>`. The factory's pull requests target the repository's default branch: a repository whose working trunk is not its default branch is not supported.

## Ask before

Ask the owner, in the session, before each of these, and do it only on a yes:

- creating or changing the routine, and writing outside this repository, where the owner versions his routines;
- creating a label, a ruleset, or changing a repository setting;
- merging anything into `<BRANCH>`: the owner merges the install's pull request himself, or says yes to it;
- setting a secret. A secret value never passes through you: the owner types it into `gh secret set` in his own terminal.

Writing into this repository's working tree needs no ask: `install.ts` refuses to overwrite a file that differs, and git undoes the rest.

## 1. Parameters

- `REPO`: `$ARGUMENTS` when given, else `gh repo view --json nameWithOwner --jq .nameWithOwner`. It must be the repository of the current checkout: stop when the two differ, since `install.ts repo` writes into the current directory whatever `<REPO>` says. `<repo name>` below is the part of `<REPO>` after the `/`.
- `OWNER`: the login of the human who labels issues `ready` and pull requests `human-approved`. Propose `gh api user --jq .login` and have the owner confirm it: the workflows trust that login alone.
- `BRANCH`: the default branch, the base of every pull request: `gh repo view <REPO> --json defaultBranchRef --jq .defaultBranchRef.name`.
- `CI`: the name of the repository's CI workflow, its `name:` line, which `trunk-red.yml` listens to. `gh workflow list --repo <REPO>` lists the names; ask the owner which one tests the code. The ruleset requires a check named `test`: that workflow needs a job that reports it, its `name:` `test` or its id `test` with no `name:`, and no matrix, which reports `test (…)`. It runs on `pull_request`, on `push` to `<BRANCH>`, and on `merge_group` where the repository has a merge queue, with no `paths` or `paths-ignore` filter: a filtered change never gets the check. Say so now if it has none; step 6 reports it.
- `ROUTINE_ID`: the `trig_…` id of the routine, known once step 2 created it.

## 2. Environment, then routine

A cloud session gets nothing of the owner's machine: no user `CLAUDE.md`, skill, plugin or MCP server. What the Worker needs is committed in the repository, and the cloud environment it runs in is the repository's own, declared in `.github/factory/`.

### The declaration

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/install.ts" environment
```

It writes `.github/factory/environment.json` and `.github/factory/setup.sh`. Read how the repository builds and tests itself, its CI workflow first, then write with the owner what a session needs there and the cloud image lacks. Add nothing a run of the code does not need.

- `allowed_hosts` in `environment.json`: each host the build, the tests or the documentation the Worker must read are fetched from, beyond GitHub and the package registries, which `allow_package_managers` covers. A domain alone, with no scheme and no path.
- `environment_variables`: plain values. The file is as public as the repository: a variable whose name has a word ending in `secret`, `token`, `password`, `credential` or `key`, as `NPM_TOKEN` has and `MAX_OUTPUT_TOKENS` has not, is written with the value `"<redacted>"`, which `check.ts` holds it to, and its real value goes on the environment alone. A secret under another name stays out of the file.
- `PACKAGES` in `setup.sh`: the system packages CI installs with apt.
- Tools, where CI installs some the image lacks or holds others to a version: write `.github/factory/mise.toml`, a `[tools]` table, then lock it:

  ```bash
  mise -C .github/factory lock --platform linux-x64
  ```

  A session installs from the `mise.lock` this writes beside it, and fails without it: the GitHub API that resolves a version is closed to a session. Keep both files out of the repository's root when its CI installs with `jdx/mise-action`, which turns to a locked install once it finds a lockfile there. A repository whose tools the image holds needs neither file.

### The environment

Only the owner creates it, on claude.ai/code: the environment selector, *New environment*. Give him each value, and have him confirm once it exists:

- *Name*: `<repo name>`;
- *Repositories*: none; remove the one the dialog filled in;
- *Network access*: *Limited*, the hosts of `environment.json` under *Allowed domains*, *Allow package managers* as the file says;
- *Setup script*: *Choose file*, `.github/factory/setup.sh`;
- *Environment variables*: those of `environment.json`, a secret with its real value.

The dialog has no control for `allow_mcp_servers`: leave it `true` in the file.

claude.ai keeps its own copy of all of it: a later change to the declaration reaches a session once the owner applied it there, and `.claude/hooks/cloud-tools.sh` tells a session when the environment ran another setup script than its clone's.

The routine needs the environment's `env_…` id: the `schedule` skill prints the account's environments with their ids.

### The routine

A repository that already has its routine keeps it, and its `trig_…` id is `ROUTINE_ID`: render the prompt as item 2 below says, then move the routine into the environment and give it that prompt with the `RemoteTrigger` tool, action `update`, sending its whole `job_config` with the new `environment_id` and the new prompt. Saving a routine from its page on claude.ai adds an outcome branch it did not have. Version it as item 4 says, then go to step 3.

1. Ask the owner to give the Claude GitHub App access to `<REPO>` first, at <https://github.com/apps/claude>, and to confirm it. A routine created before that cannot read the repository, and its cloud session cannot push.
2. Render the prompt into a scratch directory: `mktemp -d` prints one, then

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/scripts/install.ts" prompt --owner <OWNER> --repo <REPO> --branch <BRANCH> --dir <scratch dir>
   ```

3. Create the routine from that prompt with the `RemoteTrigger` tool, action `create` (the owner's own way is `/schedule`): `name` `<repo name>: issue to PR`, `enabled` true, no cron, `model` `claude-opus-5-5`, `effort_level` `medium`, `allowed_tools` `["Bash", "Read", "Write", "Edit", "Glob", "Grep"]`, `sources` `["<REPO>"]`, `persist_session` false, that environment's id as `environment_id`, and `clear_mcp_connections` true: a routine created with no connector named gets every connector of the owner's account, mail and drive included, and the Worker needs none.
4. Only once the routine exists, version it where the owner keeps his routines: ask him where, and follow what he has. Nothing of the factory reads that copy; it is how the owner sees a routine drift from what he wrote. One convention, given as an example to adapt: a folder `~/dotfiles/cloud/routines/<repo name>-worker/` holds `prompt.md`, written by running the same `install.ts prompt` command again with that folder as `--dir`, and `routine.json` beside it on the model of an existing routine there, with the `trig_…` id; the folder's name joins the list `scripts/routines/routine.test.ts` expects there; then `bun run --cwd ~/dotfiles routines:check` exits 0. An owner who versions no routine keeps the prompt's directory and the id in his report.

The routine has no trigger yet, and only the owner can add one: on the routine's page on claude.ai, *Edit*, the *Trigger* row, **+**, *API*, *Generate token*. The token is shown once. Ask him to do it, then to run `gh secret set ROUTINE_FIRE_TOKEN --repo <REPO>` and paste it there.

## 3. Files

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/install.ts" repo --owner <OWNER> --routine <ROUTINE_ID> --branch <BRANCH> --ci <CI>
```

Run it from the repository's root. Each file prints `wrote`, `identical`, `overwrote` or `refused`; `.claude/settings.json` prints `merged` or `identical`, since the factory's hooks are added to what the file already holds, or `refused` when it is not valid JSON: `--force` does not override that one, so fix the file with the owner and run again. Any other `refused` file differs from the template: show the owner the difference and run again with `--force` only on his yes. A file adapted on purpose, the tier files of step 5 among them, stays refused on every later run; that is expected. The declaration of step 2 is not among what this command writes: `--force` never reaches it. A refused `.claude/hooks/require-verify.sh` is not one of those: it is an older script, which the merged settings now run with `start` when a session starts, and it does not know that word. Remove it and run the command again, which writes the template's; `--force` would overwrite every other file that differs too.

Then, with the owner:

- `.claude/skills/pr/` and `.claude/skills/issue/` are `github-flow`'s skills with their checks: the Worker writes a pull request's body and an issue with them, and `.claude/hooks/pr-body.ts` refuses a body the `pr` check refuses. Their caps, the words of prose, the decided facts and the lines past which a check refuses, are the defaults until the repository writes `.github/github-flow.json`; the install never writes or overwrites it. Ask the owner whether he tunes them.
- `.github/deep-review-paths` lists `/.github/` alone. Add this repository's sensitive paths, one prefix per line: the review reads every caller and test of a change there, at a higher effort.
- Merge the sections of `${CLAUDE_PLUGIN_ROOT}/templates/claude-md-sections.md` into `CLAUDE.md`: the cloud session and the review both follow them. Write `<BRANCH>` where the file says `{{BRANCH}}`. Its test command and its *Code* rules are the trial's: adapt them to this repository and show the owner the result.

## 4. Verify recipe

The cloud session verifies its change with the repository's own `verify` skill, and a hook sends it back when it forgets. Record that skill by running the bundled `/verify` once, from the repository's root:

```bash
claude -p "/verify the last commit, and record the recipe that worked in .claude/skills/verify/SKILL.md at the repository root, as you do for a project with no recorded recipe"
```

The run takes minutes: give the Bash call a 10-minute timeout, or run it in the background.

Read `.claude/skills/verify/SKILL.md` and show it to the owner. It must say how to build and exercise a change to this repository's program, and it must not carry `disable-model-invocation`: the session runs it by itself. The run verifies the last commit: where that commit is not the program, such as the factory's own files, the recipe describes the wrong thing. Then, or when the run wrote no file, write one from what the run printed: the command that launches the program, an input that exercises it, what a good and a bad result look like.

## 5. Tier

`install.ts` wrote a generic floor and a generic question. Write this repository's own, then show both files to the owner:

- `.github/factory/tier.json`: `lineCap`, the lines changed past which a change waits for the owner, and `humanPaths`, globs that always wait for him, relative to the repository root with no leading `/` or `./` (`package.json`, `migrations/**`): an anchored glob makes `tier.json` unreadable, and every change then waits for the owner. `CODEOWNERS` already holds `.github/`, `.claude/` and `CLAUDE.md` at the root, and `humanPaths` already holds `**/CLAUDE.md`, `**/CLAUDE.local.md` and `**/.claude/**`, which Claude Code loads as instructions wherever they sit: keep them. Add what configures the checks or what no check covers here: package manifests and lockfiles, the test runner's and the build's configuration, migrations, deploy and infrastructure files. Read the repository to find them.
- `.github/factory/tier-prompt.md`: keep its structure and its last three paragraphs. Rewrite the first paragraph to say what this repository is and what its code can touch, and item 1, "What a revert cannot undo", so its examples name what a run of this code writes outside the repository: its database, the services it calls, what it publishes or deletes. Name in item 2 the test command that catches a mistake.

Then the cases, right away, with the owner. Tell him what skipping this step costs: without validated cases the floor runs alone, every change that passes it is `human`, and nothing lands without him.

1. Read the merged pull requests: `gh pr list --repo <REPO> --state merged --limit 60 --json number,title,additions,deletions,files`, and `gh pr diff <n> --repo <REPO>` for the ones you are unsure of. A repository with no merged pull request has no case to build: say so, leave `tier-cases.json` as it is, and go to step 6.
2. Propose `.github/factory/tier-cases.json`: some twenty cases, each `{"name", "expected", "pr"}` with the tier you expect from the diff alone, `low` or `human`. Where history holds no change a revert cannot undo, no deleted or weakened test, no behaviour changed without a test, add each as `{"name", "expected": "human", "diff"}` with a unified diff written against this repository's code. Leave `model` and `prompt` null. The owner confirms the list.
3. Replay them; the script judges each case three times, so give the Bash call a 10-minute timeout:

   ```bash
   bun .github/factory/tier.ts replay --repo <REPO> --record
   ```

   A false `low` means the question is too loose: tighten `tier-prompt.md` and replay. A failure is not a verdict: fix its cause and replay. A run where the floor decided every case validates nothing: add cases that pass the floor. A run with no false `low`, no failure, and a case expected `human` that passes the floor and that the classifier judged `human` on all three runs ends with `validated`, and `--record` then writes the model and the prompt's digest into `tier-cases.json`; on any other run it writes nothing. Any later edit of `tier-prompt.md` needs a new `--record`: the gate answers `human` for a prompt its cases did not validate.

## 6. Land, then the GitHub side

Commit the files on a new branch, push it and open a pull request against `<BRANCH>`; the owner merges it, or says yes to its merge. On a first install, do it before the ruleset requires the checks: `owner-gate.yml` runs as it is on `<BRANCH>`, so a pull request opened before it lands waits for a check that never reports. On a repository that already runs an older factory, the pull request is held by the gate that is on `<BRANCH>`: the owner approves it with the label that gate reads, and deletes that label once the new gate, which reads `human-approved`, has landed. There, land `.github/workflows/review.yml` in a pull request of its own, after the others: the review cannot run on a pull request that changes it, and lets one through unreviewed only when every file it touches is a path of the `CODEOWNERS` on `<BRANCH>`, which lists `.github/` once the first pull request has landed.

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/check.ts" --repo <REPO>
```

One line per item, `ok` or `missing` with what fixes it; exit 1 while one is missing, and exit 2 when a read of GitHub failed: show the owner that error. An item marked `not visible` is one this token cannot read, a secret or a setting: ask the owner whether it is in place. For each missing item, tell the owner what it does and ask before running its fix:

- **Labels**: the fix creates the label. `ready`, `in-progress`, `blocked`, `needs-human`, `trunk-red`, `tier:low`, `tier:human` and `human-approved` are the factory's states.
- **Files**, and the hooks of `.claude/settings.json`: steps 3 to 5, then land them. A file that exists but says the wrong thing is an older or adapted version: `owner-gate.yml` must run `tier.ts` and read `human-approved`, `review.yml` name `needs-human`, `CODEOWNERS` list `/.github/`, `/.claude/` and `/CLAUDE.md` and hold path prefixes from the root alone, no glob, the verify skill carry no `disable-model-invocation: true`, `CLAUDE.md` name `needs-human` and `human-approved`, and `.github/factory/environment.json` hold a network, its variables and `.github/factory/setup.sh` as its setup script, with `<redacted>` for the value of each variable named like a secret.
- **CI workflow**: the workflow `trunk-red.yml` names must exist and hold a job that reports the check `test`, on pull requests, on pushes to `<BRANCH>` and, with a merge queue, on `merge_group`, with no paths filter.
- **Ruleset**: the checks, resolved threads and merge queue live in one ruleset on the default branch. The fix reads a `ruleset.json`: write it in the scratch directory of step 2, and put that path in place of `ruleset.json` in the command `check.ts` prints, so the file never lands in the repository. When the fix is a `PUT`, a ruleset already exists and `PUT` replaces all its rules: read it first with `gh api repos/<REPO>/rulesets/<id>`, keep its rules and add the missing ones. The proven body:

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

`check.ts` does not see the Claude GitHub App on the repository, nor the routine, nor the environment on claude.ai: step 2 covers the three.

Run `check.ts` again after the fixes; it exits 0 once everything is in place.

## 7. First run

Have the owner label a small issue of his `ready`, then read its run with the `RemoteTrigger` tool, action `list_runs` then `get_run_log`. A host that does not resolve or a command that is not found names what the declaration lacks: add it to `.github/factory/`, land it, and have the owner apply it to the environment before the next issue.

That log does not show what a hook printed when the session started. To read it, send the run's session one more message, from a terminal:

```bash
claude -p "Run these two read-only commands and paste their output as it is: cat ~/.cloud-env-setup.log and bash .claude/hooks/cloud-tools.sh" --cloud <session id>
```

then read the log again. `[cloud-setup] done` with no `FAILED` line, and nothing from `cloud-tools.sh`, mean the environment ran the setup script the clone holds and has the declared tools.

## Report

What `install.ts` wrote, merged and refused, and what the owner decided; the routine's directory and id; the environment's name and what its declaration holds; the verify recipe and the tier files shown to the owner; whether the cases are validated or the floor runs alone; each `check.ts` line still `missing` and what it waits for. The factory is ready when `check.ts` exits 0, the App has access and a first run started with no message from `cloud-tools.sh`.
