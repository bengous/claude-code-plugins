# Submodule setup — protocols

Supporting protocols for `SKILL.md`. Read this when you need the manual-intervention
handoff format, the state-file schema, or the default escalation rules.

<tool_usage>
## Tool Usage Guide

Use these tools for each operation type:

| Operation | Tool | Parallelization |
|-----------|------|-----------------|
| Collect parameters | `AskUserQuestion` | Single call with all parameters |
| Create GitHub repos | `Bash` | Parallel - no dependencies between repos |
| Set secrets | `Bash` | Parallel - no dependencies between repos |
| Deploy workflow files | `Write` | Parallel - independent files |
| Run git commands | `Bash` | Sequential within phase, parallel across unrelated ops |
| Validate setup | `Bash` | Sequential - each check depends on prior state |
| Read/write state | `Read`/`Write` | As needed for checkpoint operations |

**Parallel execution rule:** If two or more commands have no dependencies between them, execute them in a single message with multiple tool calls.
</tool_usage>

<manual_intervention>
## Manual Intervention Protocol

Some steps require human action in a browser (cannot be automated via CLI). When you reach these steps:

### Handoff Protocol

1. **Announce the handoff** - Clearly state what manual action is needed
2. **Provide direct URL** - Give the exact URL to navigate to
3. **List exact steps** - Number each click/selection in order
4. **Specify what to copy back** - Tell user what value to provide after
5. **Wait explicitly** - Use `AskUserQuestion` to pause until user confirms
6. **Verify completion** - Run CLI command to confirm the manual step worked

### Manual Steps in This Skill

| Phase | Manual Action | URL |
|-------|---------------|-----|
| Phase 3 | Create Fine-Grained PAT | `https://github.com/settings/personal-access-tokens/new` |
| Phase 6 | Configure GitHub Pages (if needed) | `https://github.com/{owner}/{repo}/settings/pages` |

### Example Handoff Message

```
I need you to create a Personal Access Token in the browser.

**URL:** https://github.com/settings/personal-access-tokens/new

**Steps:**
1. Click "Generate new token"
2. Token name: `submodule-sync-myproject`
3. Expiration: Select "90 days"
4. Repository access: Click "Only select repositories"
5. Select: `myorg/parent-repo` (and each submodule repo if using Pull Model)
6. Permissions → Repository permissions → Contents: "Read and write"
7. Click "Generate token"
8. **Copy the token** (starts with `github_pat_`)

Paste the token below when ready.
```

### After Manual Step

Always verify the manual action succeeded:
```bash
# After PAT creation - test it works
gh auth status  # or test API call with new token

# After GitHub Pages config
gh api repos/{owner}/{repo}/pages --jq '.source'
```
</manual_intervention>

<state_schema>
## State File Schema

Location: `.submodule-setup-state.json` in parent repo root.
Use `Read` tool to check for existing state on resume. Use `Write` tool to update after each phase.

```json
{
  "version": "1.0",
  "started_at": "2026-01-13T10:30:00Z",
  "current_phase": 2,
  "params": {
    "PARENT_REPO": "org/repo",
    "SUBMODULE_NAMES": ["docs", "exports"],
    "TARGET_DIRS": ["docs", "exports"],
    "DEFAULT_BRANCH": "dev",
    "SOURCE_BRANCHES": [],
    "SOURCE_PATHS": []
  },
  "phases": {
    "0": { "status": "completed", "backup_branch": "backup/pre-submodule-setup-20260113-103000" },
    "1": { "status": "completed" },
    "2": { "status": "in_progress", "repos_created": ["org/repo-docs"], "repos_pending": ["org/repo-exports"] }
  },
  "audit_log": [
    { "event": "phase_started", "phase": 0, "timestamp": "2026-01-13T10:30:00Z" },
    { "event": "backup_created", "branch": "backup/pre-submodule-setup-20260113-103000", "timestamp": "2026-01-13T10:30:05Z" }
  ]
}
```

**Resume logic:** If state file exists, read `current_phase` and skip completed phases. Resume from `in_progress` phase using saved progress data.
</state_schema>

<escalation_defaults>
## Default Escalation Rules

These patterns apply to all phases unless overridden:

| Error Pattern | Action | Max Retries |
|---------------|--------|-------------|
| `rate limit` | Retry with exponential backoff | 3 |
| `network error` / `timeout` | Retry | 3 |
| `already exists` | Ask user: use existing, rename, or abort | - |
| `permission denied` | Abort with auth instructions | 0 |
| `not found` | Ask user to verify input | - |
| Unknown error | Abort and report | 0 |

**Abort behavior:** On abort, update state file with `"status": "failed"` and error details. Do not delete state file - it aids debugging.
</escalation_defaults>
