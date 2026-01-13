# Troubleshooting Guide

## Rollback Procedures

### Full Rollback (Undo Entire Setup)

If setup failed or you want to revert completely:

```bash
cd /path/to/parent-repo

# 1. Find your backup branch
git branch | grep backup/pre-submodule

# 2. Reset to backup state
git reset --hard backup/pre-submodule-setup-<timestamp>

# 3. Remove submodule configuration
git submodule deinit -f --all 2>/dev/null || true
rm -rf .git/modules/* 2>/dev/null || true
rm -f .gitmodules 2>/dev/null || true

# 4. Clean up any leftover directories
# (only if they were created by submodule add)
rm -rf <submodule-dir-1> <submodule-dir-2>

# 5. Delete GitHub repos created during setup
gh repo delete <org>/<parent>-<submodule-1> --yes
gh repo delete <org>/<parent>-<submodule-2> --yes
```

### Partial Rollback (Remove One Submodule)

```bash
# 1. Deinit the specific submodule
git submodule deinit -f <submodule-path>

# 2. Remove from .gitmodules and index
git rm -f <submodule-path>

# 3. Remove from .git/modules
rm -rf .git/modules/<submodule-path>

# 4. Commit the removal
git commit -m "revert: remove <submodule-name> submodule"

# 5. Optionally delete the GitHub repo
gh repo delete <org>/<submodule-repo> --yes
```

### Rollback After Push (Already Pushed to Remote)

```bash
# 1. Reset local to backup
git reset --hard backup/pre-submodule-setup-<timestamp>

# 2. Force push to remote (CAUTION: coordinate with team)
git push --force-with-lease origin <branch>

# 3. Clean up submodule artifacts locally
git submodule deinit -f --all
rm -rf .git/modules/*
```

### Recovery if Backup Branch Deleted

```bash
# Find the commit before submodule setup via reflog
git reflog | grep -B5 "submodule add"

# Reset to that commit
git reset --hard <sha-before-submodule-add>
```

## Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Submodule empty after clone | Didn't init | Run `git submodule update --init --recursive` |
| Push rejected in submodule | Not on branch | `cd submodule && git checkout dev` |
| Parent not updating | PAT issue | Check secret exists and has correct permissions |
| Infinite workflow loops | Missing loop guard | Ensure `github.actor != 'github-actions[bot]'` condition |
| CI can't read submodule files | Missing checkout option | Add `submodules: recursive` to checkout action |
| "Conflicting directory" on setup | Old branch checkout | Script auto-cleans, or manually `rm -rf <dir>` |
| Submodule detached HEAD | Normal after update | Run `git checkout <branch>` in submodule |

## PAT (Personal Access Token) Issues

### "Bad credentials" Error

**Symptoms:**
- `gh secret set` fails with authentication error
- Workflow fails with "Resource not accessible by integration"

**Solutions:**
1. Verify PAT hasn't expired: GitHub Settings → Developer settings → Personal access tokens
2. Regenerate token and update all secrets:
   ```bash
   # Use interactive prompt (recommended) - no token in shell history
   gh secret set PARENT_REPO_PAT --repo <org>/<parent-repo>
   gh secret set PARENT_REPO_PAT --repo <org>/<submodule-repo>
   ```

### "Repository not found" in Workflow

**Symptoms:**
- `repository_dispatch` fails silently
- Parent repo never receives update event

**Solutions:**
1. Verify PAT has access to parent repo (check "Repository access" in token settings)
2. Ensure parent repo name is exact (case-sensitive): `myorg/MyProject` not `myorg/myproject`
3. Check PAT has `Contents: Read and write` permission

### Token Expiration

**Prevention:**
- Set calendar reminder 7 days before expiration
- Use GitHub's email notifications for token expiration

**Recovery:**
1. Generate new fine-grained PAT with same permissions
2. Update secret in ALL repos (parent + all submodules)
3. Delete old token

## SSH Deploy Keys for Cross-repo Access

When a workflow needs to access files from another private repo (not just trigger it), use SSH deploy keys instead of PATs. This provides fine-grained, repo-scoped access.

### Setting Up Deploy Keys

**Scenario:** Repo A needs to read `data/config.yaml` from private Repo B.

```bash
# 1. Generate key pair (no passphrase)
ssh-keygen -t ed25519 -C "repo-a-to-repo-b" -f repo-b-deploy-key -N ""

# 2. Add PUBLIC key to Repo B as deploy key (read-only)
gh repo deploy-key add repo-b-deploy-key.pub --repo owner/repo-b --title "Repo A access"

# 3. Add PRIVATE key to Repo A as secret
gh secret set REPO_B_DEPLOY_KEY --repo owner/repo-a < repo-b-deploy-key

# 4. Delete local key files
rm repo-b-deploy-key repo-b-deploy-key.pub
```

### Sparse Checkout Pattern

Use sparse checkout to fetch only specific files from a private repo:

```yaml
# In Repo A's workflow
- name: Checkout specific files from Repo B
  uses: actions/checkout@v4
  with:
    repository: owner/repo-b
    ssh-key: ${{ secrets.REPO_B_DEPLOY_KEY }}
    path: repo-b-data
    sparse-checkout: |
      data/config.yaml
      data/settings.json
    sparse-checkout-cone-mode: false
```

**Key points:**
- `sparse-checkout-cone-mode: false` enables file-level patterns (not just directories)
- Files appear under `repo-b-data/data/config.yaml`
- Deploy key only needs read access

### Cross-repo Data Dependency Example

Full pattern for "rebuild when data changes":

**In data source repo (e.g., `config-repo`):**
```yaml
# .github/workflows/notify-consumer.yml
name: Notify Consumer on Config Change
on:
  push:
    branches: [main]
    paths:
      - 'data/config.yaml'
jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger consumer rebuild
        env:
          GH_TOKEN: ${{ secrets.CONSUMER_TRIGGER_TOKEN }}
        run: gh workflow run build.yml --repo owner/consumer-repo --ref main
```

**In consumer repo (e.g., `consumer-repo`):**
```yaml
# .github/workflows/build.yml
name: Build
on: [push, workflow_dispatch]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Fetch config from source
        uses: actions/checkout@v4
        with:
          repository: owner/config-repo
          ssh-key: ${{ secrets.CONFIG_REPO_KEY }}
          path: external-config
          sparse-checkout: data/config.yaml
          sparse-checkout-cone-mode: false
      - name: Build with external config
        run: ./build.sh --config external-config/data/config.yaml
```

## Submodule State Issues

### Detached HEAD After Pull

**Normal behavior.** Submodules update to specific commits, not branches.

**To work on submodule:**
```bash
cd <submodule>
git checkout <branch>  # e.g., dev
# Make changes, commit, push
git push
```

### Submodule Shows as Modified But No Changes

**Cause:** Submodule pointer differs from checked-out commit.

**Solution:**
```bash
# Option 1: Update parent to match submodule
git add <submodule>
git commit -m "chore: update submodule pointer"

# Option 2: Reset submodule to parent's expected commit
git submodule update --init <submodule>
```

### "Reference is not a tree" Error

**Cause:** Submodule commit doesn't exist in remote (force-pushed or deleted).

**Solution:**
```bash
# Update submodule to latest remote
git submodule update --remote <submodule>
git add <submodule>
git commit -m "fix: update submodule to valid commit"
```

## GitHub Actions Issues

### Workflow Not Triggering

**Check:**
1. Workflow file is in `.github/workflows/` directory
2. YAML syntax is valid (use `yamllint` or GitHub's editor)
3. Branch name matches trigger condition
4. `github.actor` check isn't blocking legitimate runs

### Repository Dispatch Not Working

**Requirements:**
1. PAT must have `Contents: Read and write` on target repo
2. `event-type` must match exactly between sender and receiver
3. Target repo must have workflow listening for `repository_dispatch`

**Debug:**
```bash
# Manual test of repository_dispatch
gh api repos/<org>/<parent-repo>/dispatches \
  -f event_type=submodule-updated \
  -f client_payload='{"test": "manual"}'
```

## Local Script Issues

### check-nested-repos.sh Blocking Commits

**Expected behavior** when submodules have uncommitted changes.

**Resolution:**
1. `cd <submodule>` with issues
2. Commit or stash changes
3. Return to parent and retry

### setup-dev.sh Fails on Clean Clone

**Cause:** Submodule URLs may use SSH but no SSH key configured.

**Solutions:**
```bash
# Option 1: Use HTTPS URLs
git config --global url."https://github.com/".insteadOf "git@github.com:"

# Option 2: Add SSH key
ssh-keygen -t ed25519 -C "your-email@example.com"
# Add public key to GitHub
```
