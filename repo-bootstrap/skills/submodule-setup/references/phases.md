# Submodule setup — phase reference

Full phase bodies for `SKILL.md`. Each phase carries its own `<escalation>`,
`<checkpoint>` and `<audit>` block; the orchestrator reads the phase it is about to run
rather than the whole file.

Paths: `<skill>` is this skill's base directory, the one the harness printed when
the skill loaded; this file is `<skill>/references/phases.md`.

<phase name="0" title="Backup Checkpoint">

<escalation>
  <abort>
    <condition>working tree is dirty</condition>
    <message>Working tree has uncommitted changes. Commit or stash before proceeding.</message>
  </abort>
  <abort>
    <condition>script not found</condition>
    <message>Skill not installed correctly. Verify `<skill>/` exists.</message>
  </abort>
</escalation>

<checkpoint>
  <on_complete>
    Write to state file:
    - "current_phase": 0
    - "phases.0.status": "completed"
    - "phases.0.backup_branch": "{created_branch_name}"
  </on_complete>
</checkpoint>

<audit>
  <event name="backup_created">
    <fields>branch, timestamp</fields>
  </event>
</audit>

## Phase 0: Backup Checkpoint

**Before any modifications**, create recovery point:

```bash
<skill>/scripts/create-backup.sh /path/to/parent-repo
```

This script:
- Verifies working tree is clean (aborts if dirty)
- Creates timestamped backup branch
- Saves rollback instructions to `.submodule-setup-backup`

<verification>
**Verification:** Confirm backup branch exists:
```bash
git branch --list 'backup/pre-submodule-setup-*'
```
Expected: At least one matching branch. Do not proceed until backup exists.
</verification>

<error_recovery>
**If this fails:**
- If working tree is dirty: commit or stash changes first
- If script not found: verify skill installation at `<skill>/`
</error_recovery>

**Rollback procedure** (if setup fails mid-way):
```bash
# Reset parent repo to pre-submodule state
git reset --hard backup/pre-submodule-setup-<timestamp>
git submodule deinit -f --all 2>/dev/null || true
rm -rf .git/modules/* 2>/dev/null || true

# Delete created GitHub repos (if needed)
gh repo delete <org>/<submodule-repo> --yes
```

See `references/troubleshooting.md` for detailed rollback scenarios.
</phase>

---

<phase name="1" title="Parameter Collection">

<escalation>
  <ask_user>
    <condition>required parameter missing or unclear</condition>
    <message>Please provide {missing_param}. This is required to continue.</message>
  </ask_user>
</escalation>

<checkpoint>
  <on_complete>
    Write to state file:
    - "current_phase": 1
    - "phases.1.status": "completed"
    - "params": { all collected parameters }
  </on_complete>
  <critical>true</critical>
  <note>All subsequent phases depend on these parameters. Must save before proceeding.</note>
</checkpoint>

<audit>
  <event name="params_collected">
    <fields>submodule_count, has_source_branches, timestamp</fields>
  </event>
</audit>

## Phase 1: Parameter Collection

Ask for all parameters in one message. They are free-form values, so ask in plain
text rather than through `AskUserQuestion`, whose questions take a fixed set of options:

| Parameter | Example | Notes |
|-----------|---------|-------|
| `PARENT_REPO` | `myorg/myproject` | Full GitHub path |
| `SUBMODULE_NAMES` | `docs exports` | Space-separated |
| `TARGET_DIRS` | `docs exports` | Where to mount (usually same as names) |
| `DEFAULT_BRANCH` | `dev` | Branch to track |
| `SOURCE_BRANCHES` | `docs-external,n8n-exports` | Only if extracting (leave empty for fresh start) |
| `SOURCE_PATHS` | `docs-external/,exports/` | Paths within branches (only if extracting) |

<verification>
**Verification:** All required parameters have values. `SOURCE_BRANCHES` determines whether Phase 4 executes.
</verification>

<error_recovery>
**If unclear:** Ask user to clarify. Do not assume values for `SOURCE_BRANCHES` - this controls Phase 4 execution.
</error_recovery>
</phase>

---

<phase name="2" title="Create Submodule Repos" parallelizable="true">

<escalation>
  <ask_user>
    <condition>error contains "already exists"</condition>
    <message>Repository {repo_name} already exists. Choose: use existing, rename, or abort?</message>
    <options>
      <option action="continue">Use existing repo</option>
      <option action="retry_with_suffix">Add suffix (e.g., -v2)</option>
      <option action="abort">Abort setup</option>
    </options>
  </ask_user>
  <abort>
    <condition>error contains "permission denied"</condition>
    <message>Cannot create repo. Run `gh auth status` and verify org membership.</message>
  </abort>
</escalation>

<checkpoint>
  <save_after>each repo creation</save_after>
  <state_fields>
    - "phases.2.status": "in_progress"
    - "phases.2.repos_created": ["list", "of", "created"]
    - "phases.2.repos_pending": ["remaining", "repos"]
  </state_fields>
  <resume_instruction>On resume, skip repos in repos_created, continue with repos_pending.</resume_instruction>
</checkpoint>

<audit>
  <event name="repo_created">
    <fields>repo_name, visibility, timestamp</fields>
  </event>
</audit>

## Phase 2: Create Submodule Repos

**Execute in parallel** - create all repos simultaneously with multiple Bash tool calls in one message:

```bash
# For each submodule (run these in parallel)
gh repo create <org>/<parent-name>-<submodule> \
  --private \
  --description "Submodule: <description>"
```

Example (execute both in parallel):
```bash
gh repo create myorg/myproject-docs --private --description "External documentation"
gh repo create myorg/myproject-exports --private --description "Exported workflows"
```

<verification>
**Verification:** For each repo, confirm creation succeeded:
```bash
gh repo view <org>/<repo-name> --json name -q '.name'
```
Expected: Returns repo name without error. Do not proceed to Phase 3 until all repos exist.
</verification>

<error_recovery>
**If this fails:**
- "already exists": Confirm with user whether to use existing repo or choose different name
- "permission denied": Run `gh auth status`, verify org permissions
- "not found" (org): Verify org name spelling, check membership
</error_recovery>
</phase>

---

<phase name="3" title="PAT and Secrets Setup" parallelizable="true">

<escalation>
  <abort>
    <condition>error contains "permission denied" or "not authorized"</condition>
    <message>Cannot set secrets. The account gh is logged in as needs admin access to each repository's settings. Run `gh auth status`.</message>
  </abort>
  <ask_user>
    <condition>the box was cancelled</condition>
    <message>Create the fine-grained PAT with the permissions above, then tell me when it is copied: I will open the masked box again.</message>
  </ask_user>
  <abort>
    <condition>no `mcp__secret-pane__request_secret` tool in this session</condition>
    <message>The token must not enter this conversation. Install secret-pane (`/plugin install secret-pane --marketplace bengous/claude-code-plugins`) and run the skill again, or set the secret yourself in your own terminal: `gh secret set PARENT_REPO_PAT --repo <org>/<repo>` for the parent and each submodule, which prompts for the value, then run the skill again from Phase 4.</message>
  </abort>
</escalation>

<checkpoint>
  <save_after>each secret set</save_after>
  <state_fields>
    - "phases.3.status": "in_progress"
    - "phases.3.secrets_set": ["repo1", "repo2"]
    - "phases.3.secrets_pending": ["repo3"]
  </state_fields>
</checkpoint>

<audit>
  <event name="secret_set">
    <fields>repo_name, secret_name, timestamp</fields>
    <note>Never log secret values</note>
  </event>
</audit>

## Phase 3: PAT and Secrets Setup

The token reaches GitHub through the secret-pane plugin and never through the chat: its `request_secret` tool opens a masked box the user pastes the token into, and answers a placeholder that becomes the token only inside a Bash command and is hidden again in the output. Check the tool `mcp__secret-pane__request_secret` is in this session before the handoff; without it, abort as the escalation says.

### Step 1: Create Fine-Grained PAT (Manual - Browser Required)

**This step requires human action.** Use `AskUserQuestion` with this handoff:

```
I need you to create a Personal Access Token in your browser.

**Open this URL:** https://github.com/settings/personal-access-tokens/new

**Follow these steps exactly:**

1. Click **"Generate new token"** (fine-grained)
2. **Token name:** `submodule-sync-{PARENT_REPO_NAME}`
3. **Expiration:** Select "90 days" (set a calendar reminder!)
4. **Repository access:** Click "Only select repositories"
5. **Select repositories:**
   - `{ORG}/{PARENT_REPO}` (required)
   - For Pull Model only: also select each submodule repo
6. **Permissions** → Repository permissions:
   - **Contents:** Read and write
   - **Workflows:** Read and write (optional but recommended)
7. Click **"Generate token"** at the bottom
8. **IMPORTANT:** Copy the token immediately (starts with `github_pat_`)
   - You won't be able to see it again!

**Tell me when it is copied.** I will open a masked box for it: the token never enters this conversation.
```

### Step 2: Collect the PAT

Call `request_secret` with `name` `PARENT_REPO_PAT` and the reason `the submodule sync workflows read it as a repository secret`. The answer carries the placeholder, `[secret-pane:PARENT_REPO_PAT:xxxxxxxx]`: write it as given in every command below. A cancelled box means the token is not ready: ask once more, then stop the phase.

### Step 3: Verify PAT Works

The placeholder is not restored in `gh api`, which can post text off the machine, so the check goes through curl:

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer [secret-pane:PARENT_REPO_PAT:xxxxxxxx]' https://api.github.com/repos/{ORG}/{PARENT_REPO}
```

Expected: `200`. A `404` means the token has no access to the parent repo: guide the user to regenerate it with the repository selected.

### Step 4: Set Secrets

One command per repository, the placeholder on stdin:

```bash
printf '%s' '[secret-pane:PARENT_REPO_PAT:xxxxxxxx]' | gh secret set PARENT_REPO_PAT --repo <org>/<parent>
printf '%s' '[secret-pane:PARENT_REPO_PAT:xxxxxxxx]' | gh secret set PARENT_REPO_PAT --repo <org>/<submodule-1>
printf '%s' '[secret-pane:PARENT_REPO_PAT:xxxxxxxx]' | gh secret set PARENT_REPO_PAT --repo <org>/<submodule-2>
```

The placeholder is the only form of the token ever written: the chat, the shell history and the session transcript keep the placeholder, and the real value leaves the session's memory when the session ends.

<verification>
**Verification:** List secrets for each repo:
```bash
gh secret list --repo <org>/<repo>
```
Expected: `PARENT_REPO_PAT` appears in list for parent and all submodule repos.
</verification>

<error_recovery>
**If this fails:**
- "secret not set": Verify PAT was copied correctly (no trailing whitespace)
- "permission denied": User's GitHub account needs admin access to repo settings
- "Resource not accessible": PAT doesn't have access to this repo - user must regenerate with correct repo selection
</error_recovery>
</phase>

---

<phase name="4" title="Content Migration" conditional="SOURCE_BRANCHES not empty">

<escalation>
  <ask_user>
    <condition>error contains "branch not found" or "pathspec"</condition>
    <message>Source branch '{branch}' not found. Verify branch name with `git branch -r`.</message>
  </ask_user>
  <ask_user>
    <condition>error contains "path not found" or "not a valid object"</condition>
    <message>Path '{path}' not found in branch '{branch}'. Verify with `git ls-tree origin/{branch}`.</message>
  </ask_user>
  <abort>
    <condition>error contains "permission denied" on push</condition>
    <message>Cannot push to submodule repo. Verify SSH key or use HTTPS with PAT.</message>
  </abort>
</escalation>

<checkpoint>
  <save_after>each submodule migration</save_after>
  <state_fields>
    - "phases.4.status": "in_progress"
    - "phases.4.migrated": ["docs"]
    - "phases.4.pending": ["exports"]
  </state_fields>
  <resume_instruction>On resume, skip submodules in migrated list.</resume_instruction>
</checkpoint>

<audit>
  <event name="content_migrated">
    <fields>submodule_name, source_branch, commit_sha, timestamp</fields>
  </event>
</audit>

## Phase 4: Content Migration (If Extracting)

<decision_criteria>
**Skip this phase if:** `SOURCE_BRANCHES` from Phase 1 is empty or user specified "start fresh"
</decision_criteria>

For each submodule with source branch (execute sequentially per submodule), run `mktemp -d` twice first and write the two printed paths below as `<extract-dir>` and `<clone-dir>`:

```bash
# Extract from branch
cd /path/to/parent-repo
git archive origin/<source-branch>:<source-path> | tar -x -C <extract-dir>

# Clone and populate new repo
git clone git@github.com:<org>/<submodule-repo>.git <clone-dir>/<submodule-repo>
cd <clone-dir>/<submodule-repo>
git checkout -b <default-branch>
cp -r <extract-dir>/. .
git add .
git commit -m "feat: initial content from <source-branch>"
git push -u origin <default-branch>

# Set default branch
gh repo edit <org>/<submodule-repo> --default-branch <default-branch>
```

<verification>
**Verification:** For each submodule repo:
```bash
gh api repos/<org>/<submodule-repo>/branches/<default-branch> -q '.name'
```
Expected: Returns branch name. Also verify content exists:
```bash
gh api repos/<org>/<submodule-repo>/contents -q '.[].name' | head -5
```
Expected: Lists files from extracted content.
</verification>

<error_recovery>
**If this fails:**
- "branch not found": Verify source branch name with `git branch -r`
- "path not found": Verify source path exists in branch with `git ls-tree origin/<branch>`
- "permission denied" on push: Verify SSH key or use HTTPS with PAT
</error_recovery>
</phase>

---

<phase name="5" title="Add Submodules to Parent">

<escalation>
  <ask_user>
    <condition>error contains "already exists" or "already a submodule"</condition>
    <message>Directory '{dir}' already exists. Remove existing or use --force?</message>
    <options>
      <option action="remove_and_retry">Remove directory and retry</option>
      <option action="force">Use --force flag</option>
      <option action="abort">Abort setup</option>
    </options>
  </ask_user>
  <abort>
    <condition>error contains "not a git repository"</condition>
    <message>Submodule repo URL is invalid. Verify repo exists at specified URL.</message>
  </abort>
</escalation>

<checkpoint>
  <save_after>each submodule add</save_after>
  <state_fields>
    - "phases.5.status": "in_progress"
    - "phases.5.added": [{"name": "docs", "sha": "abc123"}]
    - "phases.5.pending": ["exports"]
  </state_fields>
</checkpoint>

<audit>
  <event name="submodule_added">
    <fields>submodule_name, target_dir, commit_sha, timestamp</fields>
  </event>
</audit>

## Phase 5: Add Submodules to Parent

```bash
cd /path/to/parent-repo
git checkout <default-branch>

# For each submodule (execute sequentially - git operations require serial execution)
git submodule add -b <default-branch> \
  git@github.com:<org>/<submodule-repo>.git \
  <target-dir>

git commit -m "feat(repo): add submodules for <list>

Migrate from branch-based separation to submodule architecture.
Enables agents to access content without branch switching."
```

<verification>
**Verification:**
```bash
git submodule status
```
Expected: Each submodule listed with commit hash (no `-` prefix indicating uninitialized).
</verification>

<error_recovery>
**If this fails:**
- "already exists": Ask the user, as the escalation above says: remove the directory, use `--force`, or abort
- "not a git repository": Verify submodule repo URL is correct
- Detached HEAD in submodule: Run `git submodule update --remote`
</error_recovery>
</phase>

---

<phase name="6" title="Deploy GitHub Actions" parallelizable="true">

<decision_criteria id="phase6-sync-model">
**Sync Model Selection:**
Ask the user which sync model to use:

| Model | Use When | PAT Scope |
|-------|----------|-----------|
| **Push Model** (Recommended) | Any submodule is private, or you want minimal PAT scope | Parent repo only |
| **Pull Model** | All submodules are public AND you prefer simpler setup | Parent + all submodule repos |

- **Push Model:** Each submodule pushes its SHA to parent via repository_dispatch. Parent updates its gitlink without cloning submodules. Works with private repos using only parent repo access.
- **Pull Model:** Parent periodically pulls latest from all submodules. Requires PAT with read access to every submodule repository.

Save choice to state: `"phases.6.sync_model": "push"` or `"phases.6.sync_model": "pull"`
</decision_criteria>

<escalation>
  <abort>
    <condition>push rejected with "refusing to allow" or "workflow"</condition>
    <message>PAT lacks 'workflows' permission. Update token at GitHub Settings → Developer settings.</message>
  </abort>
</escalation>

<checkpoint>
  <save_after>each workflow deployed</save_after>
  <state_fields>
    - "phases.6.status": "in_progress"
    - "phases.6.sync_model": "push|pull"
    - "phases.6.deployed": ["parent", "docs"]
    - "phases.6.pending": ["exports"]
  </state_fields>
</checkpoint>

<audit>
  <event name="workflow_deployed">
    <fields>repo_name, workflow_file, sync_model, timestamp</fields>
  </event>
</audit>

## Phase 6: Deploy GitHub Actions

### Step 1: Select Sync Model

Use `AskUserQuestion` tool to determine sync model:
- If ANY submodule is private: recommend **Push Model**
- If ALL submodules are public: offer choice (Push Model still recommended for simplicity)

### Step 2: Parent Repo Workflow

**For Push Model:**
Use `Read` tool to get template from `<skill>/assets/update-submodules-push.yml`.

**For Pull Model:**
Use `Read` tool to get template from `<skill>/assets/update-submodules.yml`.

Use `Write` tool to create `.github/workflows/update-submodules.yml`:
- Replace `%DEFAULT_BRANCH%` with actual branch

### Step 3: Submodule Repo Workflows

**Execute in parallel** - write all workflow files simultaneously:

For each submodule, use `Write` tool to create `.github/workflows/notify-parent.yml` in the submodule directory:
- Read template from `<skill>/assets/notify-parent.yml`
- Replace `%PARENT_REPO%` with `<org>/<parent-repo>`
- Replace `%DEFAULT_BRANCH%` with actual branch
- Replace `%TARGET_DIR%` with submodule path in parent repo (e.g., `apps/docs`)

Then commit and push each submodule's workflow.

<verification>
**Verification:** Confirm workflow files exist:
```bash
# Parent repo
ls -la .github/workflows/update-submodules.yml

# Each submodule (check via API since we may not be in those directories)
gh api repos/<org>/<submodule-repo>/contents/.github/workflows/notify-parent.yml -q '.name'
```
Expected: Files exist and contain correct branch names.
</verification>

<error_recovery>
**If this fails:**
- File not created: Verify `.github/workflows/` directory exists, create if needed
- Push rejected: Verify PAT has `workflows` permission
</error_recovery>
</phase>

---

<phase name="7" title="Deploy Local Scripts">

<escalation>
  <retry max="1">
    <condition>directory does not exist</condition>
    <action>Create scripts/ directory, then retry</action>
  </retry>
</escalation>

<checkpoint>
  <on_complete>
    - "phases.7.status": "completed"
    - "phases.7.scripts": ["setup-dev.sh", "check-nested-repos.sh"]
  </on_complete>
</checkpoint>

<audit>
  <event name="script_deployed">
    <fields>script_name, timestamp</fields>
  </event>
</audit>

## Phase 7: Deploy Local Scripts

Use `Read` tool to get templates, `Write` tool to create scripts, then `Bash` for chmod:

**setup-dev.sh:**
- Read template from `<skill>/scripts/setup-dev.sh`
- Replace `%SUBMODULES%` → actual submodule list (space-separated)
- Replace `%DEFAULT_BRANCH%` → actual branch
- Write to `scripts/setup-dev.sh`

**check-nested-repos.sh:**
- Read template from `<skill>/scripts/check-nested-repos.sh`
- Replace `%SUBMODULES%` → actual submodule list (space-separated)
- Write to `scripts/check-nested-repos.sh`

Make executable:
```bash
chmod +x scripts/setup-dev.sh scripts/check-nested-repos.sh
```

<error_recovery>
**If this fails:**
- "No such file or directory": Create `scripts/` directory first
- Permission denied on chmod: Check filesystem permissions
</error_recovery>
</phase>

---

<phase name="8" title="Claude Code Hooks" optional="true">

<escalation>
  <ask_user>
    <condition>settings file exists with different content</condition>
    <message>Existing .claude/settings.local.json found. Merge with new hooks or overwrite?</message>
    <options>
      <option action="merge">Merge (preserve existing settings)</option>
      <option action="overwrite">Overwrite (replace entirely)</option>
      <option action="skip">Skip hook configuration</option>
    </options>
  </ask_user>
</escalation>

<checkpoint>
  <on_complete>
    - "phases.8.status": "completed"
    - "phases.8.hooks_configured": true
  </on_complete>
</checkpoint>

<audit>
  <event name="hooks_configured">
    <fields>merged_or_new, timestamp</fields>
  </event>
</audit>

## Phase 8: Claude Code Hooks (Optional)

Ask user if they want Claude Code hooks configured. If yes:

Use `Read` tool to check if `.claude/settings.local.json` exists.
- If exists: ask the user, as the escalation above says: merge, overwrite, or skip
- If not: create new file

Use `Write` tool to create or update `.claude/settings.local.json`:

```json
{
  "permissions": {
    "allow": [
      "Bash(git add:*)",
      "Bash(git commit:*)",
      "Bash(git push)"
    ]
  },
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash(git commit:*)",
        "hooks": [
          {
            "type": "command",
            "command": "scripts/check-nested-repos.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "scripts/check-nested-repos.sh --end-of-task"
          }
        ]
      }
    ]
  }
}
```

<error_recovery>
**If this fails:**
- JSON syntax error: Validate JSON before writing
- File exists with different content: Ask the user, as the escalation above says
</error_recovery>
</phase>

---

<phase name="9" title="Update Documentation">

<escalation>
  <retry max="1">
    <condition>README.md does not exist</condition>
    <action>Create README.md with submodule section</action>
  </retry>
</escalation>

<checkpoint>
  <on_complete>
    - "phases.9.status": "completed"
    - "phases.9.docs_updated": true
  </on_complete>
</checkpoint>

<audit>
  <event name="docs_updated">
    <fields>file_updated, timestamp</fields>
  </event>
</audit>

## Phase 9: Update Documentation

Add submodule documentation to project's README.md or CLAUDE.md.

Use `Read` tool to get template from `<skill>/assets/README-template.md`.
Use `Read` tool to get existing README.md content.
Use `Edit` tool to append submodule section to existing README (do not overwrite).

Key sections to include:
- Repository structure table (directories → repos → purposes)
- Setup instructions for new clones
- Working with submodules workflow
- CI/CD checkout note (`submodules: recursive`)

<error_recovery>
**If this fails:**
- README.md doesn't exist: Create it with submodule section
- Merge conflict with existing content: Use Edit tool to append, don't overwrite
</error_recovery>
</phase>

---

<phase name="10" title="Validation">

<escalation>
  <continue_on_failure>true</continue_on_failure>
  <note>Validation failures are informational. Report all results, don't abort on individual check failures.</note>
</escalation>

<checkpoint>
  <on_complete>
    - "phases.10.status": "completed"
    - "phases.10.validation_results": {
        "submodules_initialized": true,
        "git_config_applied": true,
        "push_flow_works": false,
        "fail_fast_script_works": true,
        "cleanup_successful": true
      }
  </on_complete>
</checkpoint>

<audit>
  <event name="validation_complete">
    <fields>checks_passed, checks_failed, details, timestamp</fields>
  </event>
</audit>

## Phase 10: Validation

Execute validation checklist sequentially:

```bash
# 1. Submodules initialized
git submodule status
# Expected: No '-' prefix (initialized)

# 2. Git config applied
git config --get submodule.recurse        # Expected: true
git config --get push.recurseSubmodules   # Expected: on-demand

# 3. Test push flow
cd <submodule>
echo "test" >> test.md
git add . && git commit -m "test: verify sync"
git push
cd ..
# Wait 2-3 minutes, then:
git fetch && git log --oneline -3
# Expected (Pull Model): "chore(submodules): auto-update to latest [skip ci]"
# Expected (Push Model): "chore: update <submodule-name> submodule"

# 4. Test fail-fast script
cd <submodule>
echo "uncommitted" >> temp.md
cd ..
./scripts/check-nested-repos.sh
# Expected: Exit 1 with "NESTED REPOS: ACTION REQUIRED"

# 5. Cleanup (local files only)
cd <submodule> && rm test.md temp.md 2>/dev/null; git checkout .; cd ..
# Note: The "test: verify sync" commit remains in submodule history.
# This is acceptable - it verifies the sync actually works end-to-end.
```

<verification>
**Final success criteria:**
- [ ] All submodules show commit hash (no `-` prefix) in `git submodule status`
- [ ] Push to submodule triggers parent auto-update within 3 minutes
- [ ] `check-nested-repos.sh` detects uncommitted changes
- [ ] All workflow files deployed to correct repos
</verification>
</phase>

---

## Finalization

After Phase 10 completes successfully:

1. Update state file with final status:
```json
{
  "current_phase": 10,
  "phases.10.status": "completed",
  "completed_at": "ISO8601 timestamp"
}
```

2. Commit all changes to parent repo:
```bash
git add .
git commit -m "feat(repo): complete submodule setup

- Added submodules: <list>
- Configured GitHub Actions for auto-sync
- Added helper scripts and documentation"
git push
```

3. Optionally remove state file (or keep for audit):
```bash
rm .submodule-setup-state.json  # Optional
```

---
