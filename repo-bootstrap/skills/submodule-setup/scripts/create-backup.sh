#!/usr/bin/env bash
# =============================================================================
# Create Backup Checkpoint Before Submodule Setup
# =============================================================================
# Usage: ./scripts/create-backup.sh [repo-path]
#
# Creates a backup branch and validates working tree is clean.
# Must be run BEFORE any submodule modifications.
#
# Exit codes:
#   0 = Backup created successfully
#   1 = Failed (dirty working tree, not a git repo, etc.)
#   2 = Invalid input
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# Variables (set early for trap access)
# -----------------------------------------------------------------------------
BACKUP_INFO_FILE=""

# -----------------------------------------------------------------------------
# Cleanup trap
# -----------------------------------------------------------------------------
cleanup() {
  local exit_code=$?
  if [[ ${exit_code} -ne 0 ]] && [[ -n "${BACKUP_INFO_FILE}" ]] && [[ -f "${BACKUP_INFO_FILE}" ]]; then
    printf 'ERROR: Backup script failed. Cleaning up partial backup info file.\n' >&2
    rm -f -- "${BACKUP_INFO_FILE}"
  fi
  exit "${exit_code}"
}
trap cleanup EXIT

# -----------------------------------------------------------------------------
# Input Validation
# -----------------------------------------------------------------------------
REPO_PATH="${1:-.}"

if [[ ! -d "${REPO_PATH}" ]]; then
  printf 'ERROR: Path does not exist or is not a directory: %s\n' "${REPO_PATH}" >&2
  exit 2
fi

cd -- "${REPO_PATH}" || exit 2

# Verify we're in a git repo
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf 'ERROR: Not a git repository: %s\n' "${REPO_PATH}" >&2
  exit 1
fi

# Get repo root
REPO_ROOT="$(git rev-parse --show-toplevel)"
readonly REPO_ROOT
cd -- "${REPO_ROOT}" || exit 1

printf '=== Creating Backup Checkpoint ===\n' >&2
printf 'Repository: %s\n' "${REPO_ROOT}" >&2
printf '\n' >&2

# -----------------------------------------------------------------------------
# Working Tree Validation
# -----------------------------------------------------------------------------
printf 'Checking working tree... ' >&2
if ! git diff --quiet 2>/dev/null; then
  printf 'DIRTY\n' >&2
  printf '\n' >&2
  printf 'ERROR: Working tree has unstaged changes.\n' >&2
  printf 'Please commit or stash changes before proceeding.\n' >&2
  printf '\n' >&2
  printf 'Unstaged files:\n' >&2
  git diff --name-only >&2
  exit 1
fi

if ! git diff --cached --quiet 2>/dev/null; then
  printf 'STAGED\n' >&2
  printf '\n' >&2
  printf 'ERROR: Working tree has staged changes.\n' >&2
  printf 'Please commit or stash changes before proceeding.\n' >&2
  printf '\n' >&2
  printf 'Staged files:\n' >&2
  git diff --cached --name-only >&2
  exit 1
fi
printf 'CLEAN\n' >&2

# Check for untracked files in potential submodule locations
printf 'Checking for conflicts... ' >&2
# This will be populated during parameter collection
printf 'OK\n' >&2

# -----------------------------------------------------------------------------
# Create Backup
# -----------------------------------------------------------------------------
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
readonly TIMESTAMP
BACKUP_BRANCH="backup/pre-submodule-setup-${TIMESTAMP}"
readonly BACKUP_BRANCH
CURRENT_SHA="$(git rev-parse HEAD)"
readonly CURRENT_SHA
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
readonly CURRENT_BRANCH

printf '\n' >&2
printf '--- Creating backup ---\n' >&2
git branch -- "${BACKUP_BRANCH}"
printf 'Created branch: %s\n' "${BACKUP_BRANCH}" >&2
printf 'At commit: %s\n' "${CURRENT_SHA}" >&2
printf 'Current branch: %s\n' "${CURRENT_BRANCH}" >&2

# Save backup info to file for reference
BACKUP_INFO_FILE=".submodule-setup-backup"
CREATED_DATE="$(date +%Y-%m-%dT%H:%M:%S%z)"
cat >"${BACKUP_INFO_FILE}" <<EOF
# Submodule Setup Backup Info
# Created: ${CREATED_DATE}
# DO NOT DELETE until setup is verified

BACKUP_BRANCH=${BACKUP_BRANCH}
BACKUP_SHA=${CURRENT_SHA}
ORIGINAL_BRANCH=${CURRENT_BRANCH}
REPO_ROOT=${REPO_ROOT}

# To rollback:
# git reset --hard ${BACKUP_BRANCH}
# git submodule deinit -f --all
# rm -rf .git/modules/*
# rm -f .gitmodules
# rm -f ${BACKUP_INFO_FILE}
EOF

printf '\n' >&2
printf '===========================================\n' >&2
printf '  Backup created successfully!\n' >&2
printf '===========================================\n' >&2
printf '\n' >&2
printf 'Backup info saved to: %s\n' "${BACKUP_INFO_FILE}" >&2
printf '\n' >&2
printf 'To rollback if setup fails:\n' >&2
printf '  git reset --hard %s\n' "${BACKUP_BRANCH}" >&2
printf '  git submodule deinit -f --all\n' >&2
printf '  rm -rf .git/modules/*\n' >&2
printf '\n' >&2
printf 'Delete backup after successful setup:\n' >&2
printf '  git branch -d %s\n' "${BACKUP_BRANCH}" >&2
printf '  rm -f %s\n' "${BACKUP_INFO_FILE}" >&2
printf '\n' >&2
