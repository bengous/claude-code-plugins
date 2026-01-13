#!/usr/bin/env bash
# =============================================================================
# Check Nested Repos for Uncommitted/Unpushed Changes
# =============================================================================
# Usage: ./scripts/check-nested-repos.sh [--end-of-task]
#
# TEMPLATE VARIABLES (replace before use):
#   NESTED_REPOS - Array of submodule directory names
#   Example: NESTED_REPOS=(docs exports)
#
# FAIL-FAST: Exits with code 1 to block operations when issues found
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
# Example: NESTED_REPOS=(docs exports configs)
NESTED_REPOS=(%SUBMODULES%)

# -----------------------------------------------------------------------------
# Template Validation
# -----------------------------------------------------------------------------
validate_template_vars() {
  if [[ ${#NESTED_REPOS[@]} -eq 0 ]]; then
    printf 'ERROR: NESTED_REPOS is empty. Configure this script before use.\n' >&2
    printf 'Edit %s and set NESTED_REPOS=(your submodule dirs)\n' "$0" >&2
    exit 2
  fi

  # Check if template placeholder is still present (first element contains %)
  if [[ "${NESTED_REPOS[0]}" == *"%"* ]]; then
    printf 'ERROR: NESTED_REPOS not configured. Replace %%SUBMODULES%% in this script.\n' >&2
    printf 'Example: NESTED_REPOS=(docs exports)\n' >&2
    exit 2
  fi
}

# -----------------------------------------------------------------------------
# Argument Parsing
# -----------------------------------------------------------------------------
END_OF_TASK="${1:-}"

if [[ -n "${END_OF_TASK}" ]] && [[ "${END_OF_TASK}" != "--end-of-task" ]]; then
  printf 'ERROR: Unknown argument: %s\n' "${END_OF_TASK}" >&2
  printf 'Usage: %s [--end-of-task]\n' "$0" >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# Main Logic
# -----------------------------------------------------------------------------
validate_template_vars

ISSUES=""

cd -- "${REPO_ROOT}" || exit 1

for repo in "${NESTED_REPOS[@]}"; do
  # Check if it's a submodule (has .git file or directory)
  if [[ -d "${repo}/.git" ]] || [[ -f "${repo}/.git" ]]; then
    # Use git -C to run commands in submodule directory without changing cwd
    # This avoids pushd/popd fragility and subshell variable scoping issues

    # Check uncommitted changes (staged or unstaged)
    if ! git -C "${repo}" diff --quiet 2>/dev/null || ! git -C "${repo}" diff --cached --quiet 2>/dev/null; then
      ISSUES="${ISSUES}\n  - ${repo}/: uncommitted changes"
    fi

    # Check untracked files
    # shellcheck disable=SC2312  # We check output presence, not exit status; stderr redirected
    if [[ -n "$(git -C "${repo}" ls-files --others --exclude-standard 2>/dev/null)" ]]; then
      ISSUES="${ISSUES}\n  - ${repo}/: untracked files"
    fi

    # Check unpushed commits (only for end-of-task)
    if [[ "${END_OF_TASK}" == "--end-of-task" ]]; then
      # Check if upstream is configured and has unpushed commits
      # shellcheck disable=SC1083  # @{u} is valid git refspec syntax, not brace expansion
      if git -C "${repo}" rev-parse --verify "@{u}" >/dev/null 2>&1; then
        # shellcheck disable=SC1083,SC2312  # @{u} is git refspec; we check output, not exit status
        if [[ -n "$(git -C "${repo}" log "@{u}.." 2>/dev/null)" ]]; then
          ISSUES="${ISSUES}\n  - ${repo}/: unpushed commits"
        fi
      fi
    fi
  fi
done

if [[ -n "${ISSUES}" ]]; then
  printf '\n' >&2
  printf '========================================\n' >&2
  printf '  NESTED REPOS: ACTION REQUIRED\n' >&2
  printf '========================================\n' >&2
  printf '%b\n' "${ISSUES}" >&2
  printf '\n' >&2
  printf 'Commit/push changes in nested repos first.\n' >&2
  printf '========================================\n' >&2
  exit 1
fi

exit 0
