---
name: submodule-setup
description: This skill should be used when the user asks to "set up submodules", "migrate branches to submodules", "automate submodule sync", "create submodule architecture", "convert branches to repos", or mentions setting up git submodules with GitHub Actions automation for multi-repo synchronization.
---

# Submodule Setup

<overview>
Automates the setup of git submodule architecture with fully automated parent-child
synchronization via GitHub Actions. Transforms branch-based content separation into
always-present submodule directories, eliminating context-switching for agents and
developers.

**Result:**
```
parent-repo/
├── src/
├── docs/              <- submodule (always present)
└── exports/           <- submodule (always present)
```
</overview>

## Reference material

This skill is phase-driven and the phase bodies are long. Load what the current step needs
rather than reading everything up front:

| File | Read it when |
|------|--------------|
| `references/phases.md` | Running any phase — full bodies for Phases 0-10 and Finalization |
| `references/protocols.md` | You need the tool-usage guide, manual-intervention handoff format, state-file schema, or default escalation rules |
| `references/troubleshooting.md` | A phase fails or a submodule misbehaves |
| `references/decision-rationale.md` | The user asks why submodules over alternatives |

Templates live in `assets/`, helper scripts in `scripts/`. Resolve both through
`${CLAUDE_PLUGIN_ROOT}` — never a hardcoded install path.

## Prerequisites

```bash
"${CLAUDE_PLUGIN_ROOT}/skills/submodule-setup/scripts/validate-prerequisites.sh"
```

**Required:**
- GitHub CLI (`gh`) installed and authenticated
- Git 2.x+
- Repository with push access
- Ability to create fine-grained PAT

<workflow>
## Workflow

```
Phase 0: Backup  →  Phase 1: Parameters  →  Phase 2: Create Repos  →  Phase 3: PAT/Secrets
                                                                              ↓
Phase 10: Validate  ←  Phase 9: Docs  ←  Phase 8: Hooks  ←  Phase 7: Scripts  ←  Phase 6: Actions
                                                                              ↑
                                    Phase 5: Add Submodules  ←  Phase 4: Migrate (conditional)
```

| Phase | Purpose |
|-------|---------|
| 0 | Backup checkpoint — recovery point before any modification |
| 1 | Parameter collection |
| 2 | Create submodule repos |
| 3 | PAT and secrets setup |
| 4 | Content migration (conditional — see below) |
| 5 | Add submodules to parent |
| 6 | Deploy GitHub Actions |
| 7 | Deploy local scripts |
| 8 | Claude Code hooks (optional) |
| 9 | Update documentation |
| 10 | Validation |

Run each phase from `references/phases.md`, which carries that phase's progress reporting,
escalation conditions, checkpoint writes, and audit events.

<decision_criteria id="phase4">
**Phase 4 Decision:**
- Execute Phase 4 if: User provided `SOURCE_BRANCHES` in Phase 1
- Skip Phase 4 if: `SOURCE_BRANCHES` is empty or user says "start fresh"
</decision_criteria>

<resume_behavior>
**On Resume:**
1. Read `.submodule-setup-state.json`
2. Find phase with `"status": "in_progress"`
3. Use phase-specific progress data to continue (e.g., `repos_created` list)
4. If no in_progress phase, start from first `"status": "pending"` phase
</resume_behavior>
</workflow>

## Quick Reference

| Task | Command |
|------|---------|
| Clone with submodules | `git clone --recurse-submodules <url>` |
| Init after clone | `./scripts/setup-dev.sh` |
| Update submodules | `git submodule update --remote` |
| Check submodule status | `git submodule status` |
| Check for uncommitted | `./scripts/check-nested-repos.sh` |
| Check for unpushed | `./scripts/check-nested-repos.sh --end-of-task` |
| Checkout submodule branch | `cd <submodule> && git checkout <branch>` |
| Force re-init | `git submodule update --init --recursive --force` |
| Resume interrupted setup | Read `.submodule-setup-state.json` and continue from `current_phase` |

## Resources

### Scripts
- **`scripts/validate-prerequisites.sh`** - Run before starting setup
- **`scripts/create-backup.sh`** - Create backup checkpoint before modifications
- **`scripts/setup-dev.sh`** - Template for new clone initialization
- **`scripts/check-nested-repos.sh`** - Template for commit validation

### Templates
- **`assets/update-submodules.yml`** - GitHub Action for parent repo (Pull Model)
- **`assets/update-submodules-push.yml`** - GitHub Action for parent repo (Push Model)
- **`assets/notify-parent.yml`** - GitHub Action for each submodule
- **`assets/notify-dependent.yml`** - GitHub Action for cross-repo notifications
- **`assets/README-template.md`** - Documentation template for project README
