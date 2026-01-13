#!/usr/bin/env bash
# =============================================================================
# Development Environment Setup Script (Template)
# =============================================================================
#
# TEMPLATE VARIABLES (replace before use):
#   SUBMODULES - Array of submodule directory names
#   DEFAULT_BRANCH - Default branch name (e.g., dev, main)
#
# USAGE:
#   ./scripts/setup-dev.sh
#
# DESCRIPTION:
#   Initializes the development environment after cloning the repository.
#   This script configures git submodules and automation settings.
#
# ALTERNATIVE (for fresh clones):
#   git clone --recurse-submodules <repo-url>
#   ./scripts/setup-dev.sh   # Still needed for git config
#
# =============================================================================
#
# ARCHITECTURE:
#
#   parent-repo/
#   ├── <submodule-1>/    --> <parent-repo>-<submodule-1> (submodule)
#   ├── <submodule-2>/    --> <parent-repo>-<submodule-2> (submodule)
#   └── [other content...]
#
# DATA FLOW (automated via GitHub Actions):
#
#   ┌─────────────────┐     push      ┌─────────────────┐
#   │ Submodule repo  │ ────────────> │ notify-parent   │
#   │ (docs)          │               │ workflow        │
#   └─────────────────┘               └────────┬────────┘
#                                              │
#                                    repository_dispatch
#                                              │
#                                              v
#   ┌─────────────────┐               ┌─────────────────┐
#   │ Parent repo     │ <──────────── │ update-submodule│
#   │                 │  auto-commit  │ workflow        │
#   └─────────────────┘               └─────────────────┘
#
# =============================================================================
#
# WHAT THIS SCRIPT DOES:
#
#   1. Cleans up conflicting directories (from old branch-based workflow)
#   2. Initializes submodules with --force (handles edge cases)
#   3. Checks out the correct branch in each submodule
#   4. Configures git for automatic submodule handling:
#      - submodule.recurse=true     → git pull auto-updates submodules
#      - push.recurseSubmodules=on-demand → git push auto-pushes submodules
#      - status.submodulesummary=1  → git status shows submodule changes
#      - diff.submodule=log         → git diff shows submodule commit log
#   5. Makes helper scripts executable
#
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# Constants
# -----------------------------------------------------------------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly REPO_ROOT

# CUSTOMIZE: Replace %SUBMODULES% with your submodule directory names
# Example: SUBMODULES=(docs exports configs)
SUBMODULES=(%SUBMODULES%)

# CUSTOMIZE: Replace %DEFAULT_BRANCH% with your default branch name
# Example: DEFAULT_BRANCH="dev" or DEFAULT_BRANCH="main"
DEFAULT_BRANCH="%DEFAULT_BRANCH%"

# -----------------------------------------------------------------------------
# Cleanup trap
# -----------------------------------------------------------------------------
cleanup() {
  local exit_code=$?
  if [[ ${exit_code} -ne 0 ]]; then
    printf '\n' >&2
    printf 'ERROR: Setup failed.\n' >&2
    printf 'To reset submodules and retry:\n' >&2
    printf '  git submodule deinit -f --all\n' >&2
    printf '  git submodule update --init --recursive --force\n' >&2
  fi
  exit "${exit_code}"
}
trap cleanup EXIT

# -----------------------------------------------------------------------------
# Template Validation
# -----------------------------------------------------------------------------
validate_template_vars() {
  local errors=0

  if [[ ${#SUBMODULES[@]} -eq 0 ]]; then
    printf 'ERROR: SUBMODULES is empty. Configure this script before use.\n' >&2
    errors=$((errors + 1))
  elif [[ "${SUBMODULES[0]}" == *"%"* ]]; then
    printf 'ERROR: SUBMODULES not configured. Replace %%SUBMODULES%% in this script.\n' >&2
    printf 'Example: SUBMODULES=(docs exports)\n' >&2
    errors=$((errors + 1))
  fi

  if [[ -z "${DEFAULT_BRANCH}" ]] || [[ "${DEFAULT_BRANCH}" == *"%"* ]]; then
    printf 'ERROR: DEFAULT_BRANCH not configured. Replace %%DEFAULT_BRANCH%% in this script.\n' >&2
    printf 'Example: DEFAULT_BRANCH="dev"\n' >&2
    errors=$((errors + 1))
  fi

  if [[ ${errors} -gt 0 ]]; then
    exit 2
  fi
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
validate_template_vars

printf '=== Development Environment Setup ===\n'
printf 'Repository: %s\n' "${REPO_ROOT}"
printf '\n'

# Initialize and update submodules
printf '--- Initializing submodules ---\n'
cd -- "${REPO_ROOT}" || exit 1

# Back up any existing directories that conflict with submodules
REPO_NAME="$(basename "${REPO_ROOT}")"
CONFLICT_BACKUP_DIR="${REPO_ROOT}/../.${REPO_NAME}-submodule-backups"
for submodule in "${SUBMODULES[@]}"; do
  if [[ -d "${submodule}" ]] && [[ ! -f "${submodule}/.git" ]] && [[ ! -d "${submodule}/.git/objects" ]]; then
    mkdir -p "${CONFLICT_BACKUP_DIR}"
    backup_name="${submodule//\//_}.$(date +%s)"
    printf '  Moving conflicting directory: %s/ -> %s/%s\n' "${submodule}" "${CONFLICT_BACKUP_DIR}" "${backup_name}"
    mv -- "${submodule}" "${CONFLICT_BACKUP_DIR}/${backup_name}"
  fi
done

# Initialize and force checkout submodules
git submodule update --init --recursive --force

# Ensure each submodule is on the correct branch
printf '\n'
printf '--- Checking out submodule branches ---\n'
# shellcheck disable=SC2016  # Escaped vars ($toplevel/$name) expand inside foreach, not here
git submodule foreach "git checkout \$(git config -f \"\$toplevel/.gitmodules\" \"submodule.\$name.branch\" || echo '${DEFAULT_BRANCH}') 2>/dev/null || true"

# Configure git for submodule automation (per-clone settings)
printf '\n'
printf '--- Configuring git for submodule automation ---\n'
git config submodule.recurse true
git config push.recurseSubmodules on-demand
git config status.submodulesummary 1
git config diff.submodule log

# shellcheck disable=SC2312  # We just set these values; git config --get cannot fail here
{
  printf '  submodule.recurse = %s\n' "$(git config --get submodule.recurse)"
  printf '  push.recurseSubmodules = %s\n' "$(git config --get push.recurseSubmodules)"
  printf '  status.submodulesummary = %s\n' "$(git config --get status.submodulesummary)"
  printf '  diff.submodule = %s\n' "$(git config --get diff.submodule)"
}

# Make hook scripts executable
printf '\n'
printf '--- Making scripts executable ---\n'
chmod +x "${SCRIPT_DIR}/check-nested-repos.sh" 2>/dev/null || true

printf '\n'
printf '===========================================\n'
printf '  Setup complete!\n'
printf '===========================================\n'
printf '\n'
printf 'Submodule status:\n'
git submodule status
printf '\n'
printf 'For future clones, you can use:\n'
printf '  git clone --recurse-submodules <repo-url>\n'
printf '\n'

# Show recovery instructions if backups were created
if [[ -d "${CONFLICT_BACKUP_DIR}" ]]; then
  printf 'Note: Conflicting directories were backed up to:\n'
  printf '  %s/\n' "${CONFLICT_BACKUP_DIR}"
  printf 'To restore: mv "%s/<backup>" <original-path>\n' "${CONFLICT_BACKUP_DIR}"
  printf 'To delete backups: rm -rf "%s"\n' "${CONFLICT_BACKUP_DIR}"
  printf '\n'
fi
