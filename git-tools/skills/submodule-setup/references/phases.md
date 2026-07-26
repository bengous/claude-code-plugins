# Submodule setup — phase reference

Full phase bodies for `SKILL.md`. Each phase carries its own `<progress>`,
`<escalation>`, `<checkpoint>` and `<audit>` block; the orchestrator reads the phase it is
about to run rather than the whole file.

<phase name="0" title="Backup Checkpoint">

<progress>
  <status_key>phase_0_backup</status_key>
  <on_start>Creating backup checkpoint</on_start>
  <on_complete>Backup created: {backup_branch}</on_complete>
</progress>

<escalation>
  <abort>
    <condition>working tree is dirty</condition>
    <message>Working tree has uncommitted changes. Commit or stash before proceeding.</message>
  </abort>
  <abort>
    <condition>script not found</condition>
    <message>Skill not installed correctly. Verify ${CLAUDE_PLUGIN_ROOT}/skills/submodule-setup/ exists.</message>
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
${CLAUDE_PLUGIN_ROOT}/skills/submodule-setup/scripts/create-backup.sh /path/to/parent-repo
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
- If script not found: verify skill installation at `${CLAUDE_PLUGIN_ROOT}/skills/submodule-setup/`
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

<progress>
  <status_key>phase_1_params</status_key>
  <on_start>Collecting configuration parameters</on_start>
  <on_complete>Parameters collected for {submodule_count} submodules</on_complete>
</progress>

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

Use `AskUserQuestion` tool to collect all parameters in a single call:

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

<progress>
  <status_key>phase_2_create_repos</status_key>
  <on_start>Creating {submodule_count} repositories on GitHub</on_start>
  <on_complete>All repositories created successfully</on_complete>
  <trackable_items>
    <item key="repos_created" type="counter" target="{SUBMODULE_COUNT}"/>
  </trackable_items>
</progress>

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

<progress>
  <status_key>phase_3_secrets</status_key>
  <on_start>Configuring PAT and secrets for {repo_count} repositories</on_start>
  <on_complete>Secrets configured for all repositories</on_complete>
  <trackable_items>
    <item key="secrets_set" type="counter" target="{TOTAL_REPOS}"/>
  </trackable_items>
</progress>

<escalation>
  <abort>
    <condition>error contains "permission denied" or "not authorized"</condition>
    <message>Cannot set secrets. Token needs admin access to repository settings. Check PAT permissions.</message>
  </abort>
  <ask_user>
    <condition>PAT not provided</condition>
    <message>Please create a fine-grained PAT with the specified permissions and provide it.</message>
  </ask_user>
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

**Paste the token when ready** (I'll store it securely as a GitHub secret).
```

Wait for user to provide the PAT before proceeding.

### Step 2: Verify PAT Works

After receiving the PAT, verify it has correct permissions:

```bash
# Test PAT can access parent repo
# Use read -rs to avoid token in shell history
read -rs PAT && echo
GH_TOKEN="$PAT" gh api repos/{ORG}/{PARENT_REPO} --jq '.full_name'
```

If this fails, guide user to check token permissions.

### Step 3: Set Secrets

**Execute in parallel** - set all secrets simultaneously.

**Option A (recommended):** Use interactive prompt - no token in history:
```bash
gh secret set PARENT_REPO_PAT --repo <org>/<parent>
gh secret set PARENT_REPO_PAT --repo <org>/<submodule-1>
gh secret set PARENT_REPO_PAT --repo <org>/<submodule-2>
# Each prompts for the secret value interactively
```

**Option B:** If automating with a variable (already captured securely):
```bash
# PAT must already be in $PAT variable (from read -rs above)
printf '%s' "$PAT" | gh secret set PARENT_REPO_PAT --repo <org>/<parent>
printf '%s' "$PAT" | gh secret set PARENT_REPO_PAT --repo <org>/<submodule-1>
printf '%s' "$PAT" | gh secret set PARENT_REPO_PAT --repo <org>/<submodule-2>
unset PAT  # Clear from environment when done
```

**Security note:** Never type the PAT directly in a command - it will be recorded in shell history. Use `read -rs` to capture it into a variable first, or rely on `gh secret set`'s interactive prompt.

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

<progress>
  <status_key>phase_4_migration</status_key>
  <on_start>Migrating content from {source_count} source branches</on_start>
  <on_complete>Content migrated to all submodule repositories</on_complete>
  <trackable_items>
    <item key="submodules_migrated" type="counter" target="{SUBMODULE_COUNT}"/>
  </trackable_items>
</progress>

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

For each submodule with source branch (execute sequentially per submodule):

```bash
# Extract from branch
cd /path/to/parent-repo
rm -rf /tmp/extract && mkdir -p /tmp/extract
git archive origin/<source-branch>:<source-path> | tar -x -C /tmp/extract/

# Clone and populate new repo
cd /tmp
git clone git@github.com:<org>/<submodule-repo>.git
cd <submodule-repo>
git checkout -b <default-branch>
cp -r /tmp/extract/* .
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

<progress>
  <status_key>phase_5_add_submodules</status_key>
  <on_start>Adding {submodule_count} submodules to parent repository</on_start>
  <on_complete>All submodules added and committed</on_complete>
  <trackable_items>
    <item key="submodules_added" type="counter" target="{SUBMODULE_COUNT}"/>
  </trackable_items>
</progress>

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
- "already exists": Remove existing directory first, or use `--force`
- "not a git repository": Verify submodule repo URL is correct
- Detached HEAD in submodule: Run `git submodule update --remote`
</error_recovery>
</phase>

---

<phase name="6" title="Deploy GitHub Actions" parallelizable="true">

<progress>
  <status_key>phase_6_workflows</status_key>
  <on_start>Deploying GitHub Actions workflows</on_start>
  <on_complete>All workflow files deployed</on_complete>
  <trackable_items>
    <item key="workflows_deployed" type="counter" target="{SUBMODULE_COUNT + 1}"/>
  </trackable_items>
</progress>

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
Use `Read` tool to get template from `${CLAUDE_PLUGIN_ROOT}/skills/submodule-setup/assets/update-submodules-push.yml`.

**For Pull Model:**
Use `Read` tool to get template from `${CLAUDE_PLUGIN_ROOT}/skills/submodule-setup/assets/update-submodules.yml`.

Use `Write` tool to create `.github/workflows/update-submodules.yml`:
- Replace `%DEFAULT_BRANCH%` with actual branch

### Step 3: Submodule Repo Workflows

**Execute in parallel** - write all workflow files simultaneously:

For each submodule, use `Write` tool to create `.github/workflows/notify-parent.yml` in the submodule directory:
- Read template from `${CLAUDE_PLUGIN_ROOT}/skills/submodule-setup/assets/notify-parent.yml`
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

<progress>
  <status_key>phase_7_scripts</status_key>
  <on_start>Creating local helper scripts</on_start>
  <on_complete>Helper scripts deployed and made executable</on_complete>
  <trackable_items>
    <item key="scripts_created" type="counter" target="2"/>
  </trackable_items>
</progress>

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
- Read template from `${CLAUDE_PLUGIN_ROOT}/skills/submodule-setup/scripts/setup-dev.sh`
- Replace `%SUBMODULES%` → actual submodule list (space-separated)
- Replace `%DEFAULT_BRANCH%` → actual branch
- Write to `scripts/setup-dev.sh`

**check-nested-repos.sh:**
- Read template from `${CLAUDE_PLUGIN_ROOT}/skills/submodule-setup/scripts/check-nested-repos.sh`
- Replace `%SUBMODULES%` → actual submodule list (space-separated)
- Write to `scripts/check-nested-repos.sh`

Make executable:
```bash
chmod +x scripts/setup-dev.sh scripts/check-nested-repos.sh
```

<verification>
**Verification:**
```bash
ls -la scripts/*.sh | grep -E 'setup-dev|check-nested'
```
Expected: Both files listed with execute permission (`-rwxr-xr-x`).
</verification>

<error_recovery>
**If this fails:**
- "No such file or directory": Create `scripts/` directory first
- Permission denied on chmod: Check filesystem permissions
</error_recovery>
</phase>

---

<phase name="8" title="Claude Code Hooks" optional="true">

<progress>
  <status_key>phase_8_hooks</status_key>
  <on_start>Configuring Claude Code hooks</on_start>
  <on_complete>Claude Code hooks configured</on_complete>
</progress>

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
- If exists: read and merge with new hooks
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

<verification>
**Verification:**
```bash
grep -c "check-nested-repos" .claude/settings.local.json
```
Expected: Returns 2 (appears twice in hooks config).
</verification>

<error_recovery>
**If this fails:**
- JSON syntax error: Validate JSON before writing
- File exists with different content: Merge with existing settings, don't overwrite
</error_recovery>
</phase>

---

<phase name="9" title="Update Documentation">

<progress>
  <status_key>phase_9_docs</status_key>
  <on_start>Updating project documentation</on_start>
  <on_complete>Documentation updated with submodule instructions</on_complete>
</progress>

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

Use `Read` tool to get template from `${CLAUDE_PLUGIN_ROOT}/skills/submodule-setup/assets/README-template.md`.
Use `Read` tool to get existing README.md content.
Use `Edit` tool to append submodule section to existing README (do not overwrite).

Key sections to include:
- Repository structure table (directories → repos → purposes)
- Setup instructions for new clones
- Working with submodules workflow
- CI/CD checkout note (`submodules: recursive`)

<verification>
**Verification:**
```bash
grep -c "submodule" README.md
```
Expected: Multiple matches indicating submodule documentation was added.
</verification>

<error_recovery>
**If this fails:**
- README.md doesn't exist: Create it with submodule section
- Merge conflict with existing content: Use Edit tool to append, don't overwrite
</error_recovery>
</phase>

---

<phase name="10" title="Validation">

<progress>
  <status_key>phase_10_validate</status_key>
  <on_start>Running validation checklist (5 checks)</on_start>
  <on_complete>Validation complete: {passed}/{total} checks passed</on_complete>
  <trackable_items>
    <item key="checks_passed" type="counter" target="5"/>
  </trackable_items>
</progress>

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
