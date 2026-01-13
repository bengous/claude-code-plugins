#!/usr/bin/env bash
# =============================================================================
# Validate Prerequisites for Submodule Setup
# =============================================================================
# Usage: ./validate-prerequisites.sh
#
# Checks:
# 1. GitHub CLI (gh) is installed and authenticated
# 2. Git version supports submodules
# 3. Current directory is a git repository
# 4. User has necessary permissions
#
# Exit codes:
#   0 = All prerequisites met (or warnings only)
#   1 = Missing prerequisites (details in output)
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# Constants
# -----------------------------------------------------------------------------
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly NC='\033[0m' # No Color

# -----------------------------------------------------------------------------
# Variables
# -----------------------------------------------------------------------------
ERRORS=""
WARNINGS=""

# -----------------------------------------------------------------------------
# Helper Functions
# -----------------------------------------------------------------------------
print_status() {
  local color="$1"
  local status="$2"
  local detail="${3:-}"

  if [[ -n "${detail}" ]]; then
    printf '%b%s%b (%s)\n' "${color}" "${status}" "${NC}" "${detail}" >&2
  else
    printf '%b%s%b\n' "${color}" "${status}" "${NC}" >&2
  fi
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
printf '=== Submodule Setup Prerequisites Check ===\n' >&2
printf '\n' >&2

# Check 1: GitHub CLI installed
printf 'Checking GitHub CLI (gh)... ' >&2
if command -v gh >/dev/null 2>&1; then
  GH_VERSION="$(gh --version | head -1)"
  print_status "${GREEN}" "OK" "${GH_VERSION}"
else
  print_status "${RED}" "MISSING"
  ERRORS="${ERRORS}\n- GitHub CLI (gh) not installed. Install: https://cli.github.com/"
fi

# Check 2: GitHub CLI authenticated
printf 'Checking GitHub authentication... ' >&2
if gh auth status >/dev/null 2>&1; then
  GH_USER="$(gh api user --jq '.login' 2>/dev/null || echo 'unknown')"
  print_status "${GREEN}" "OK" "logged in as: ${GH_USER}"
else
  print_status "${RED}" "NOT AUTHENTICATED"
  ERRORS="${ERRORS}\n- GitHub CLI not authenticated. Run: gh auth login"
fi

# Check 3: Git installed and version
printf 'Checking Git... ' >&2
if command -v git >/dev/null 2>&1; then
  GIT_VERSION="$(git --version)"
  print_status "${GREEN}" "OK" "${GIT_VERSION}"
else
  print_status "${RED}" "MISSING"
  ERRORS="${ERRORS}\n- Git not installed"
fi

# Check 4: Current directory is git repo
printf 'Checking git repository... ' >&2
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  REPO_ROOT="$(git rev-parse --show-toplevel)"
  print_status "${GREEN}" "OK" "${REPO_ROOT}"
else
  print_status "${YELLOW}" "NOT IN REPO"
  WARNINGS="${WARNINGS}\n- Not currently in a git repository (will need to specify parent repo path)"
fi

# Check 5: Remote origin configured (if in repo)
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf 'Checking remote origin... ' >&2
  if git remote get-url origin >/dev/null 2>&1; then
    ORIGIN_URL="$(git remote get-url origin)"
    print_status "${GREEN}" "OK" "${ORIGIN_URL}"
  else
    print_status "${YELLOW}" "NOT SET"
    WARNINGS="${WARNINGS}\n- No remote 'origin' configured"
  fi
fi

# Check 6: SSH key or HTTPS credential helper
printf 'Checking GitHub access method... ' >&2
if gh auth status 2>&1 | grep -q "Token:"; then
  print_status "${GREEN}" "OK" "using token"
elif timeout 5 ssh -T git@github.com 2>&1 | grep -q "successfully authenticated"; then
  print_status "${GREEN}" "OK" "using SSH"
else
  print_status "${YELLOW}" "UNKNOWN"
  WARNINGS="${WARNINGS}\n- Could not verify GitHub access method (may still work)"
fi

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
printf '\n' >&2
printf '=========================================\n' >&2

if [[ -n "${ERRORS}" ]]; then
  printf '%bPREREQUISITES NOT MET%b\n' "${RED}" "${NC}" >&2
  printf '\n' >&2
  printf 'Errors:\n' >&2
  printf '%b\n' "${ERRORS}" >&2
  if [[ -n "${WARNINGS}" ]]; then
    printf '\n' >&2
    printf 'Warnings:\n' >&2
    printf '%b\n' "${WARNINGS}" >&2
  fi
  exit 1
elif [[ -n "${WARNINGS}" ]]; then
  printf '%bPREREQUISITES MET (with warnings)%b\n' "${YELLOW}" "${NC}" >&2
  printf '\n' >&2
  printf 'Warnings:\n' >&2
  printf '%b\n' "${WARNINGS}" >&2
  exit 0
else
  printf '%bALL PREREQUISITES MET%b\n' "${GREEN}" "${NC}" >&2
  exit 0
fi
