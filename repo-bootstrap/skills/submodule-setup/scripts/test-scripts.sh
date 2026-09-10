#!/usr/bin/env bash
# =============================================================================
# Script Validation Tests
# =============================================================================
# Usage: ./scripts/test-scripts.sh
#
# Runs static analysis and formatting checks on all shell scripts.
# Use this to verify scripts before committing.
#
# Exit codes:
#   0 = All tests passed
#   1 = One or more tests failed
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# Constants
# -----------------------------------------------------------------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
readonly SCRIPT_DIR
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly NC='\033[0m'

# -----------------------------------------------------------------------------
# Variables
# -----------------------------------------------------------------------------
FAILURES=0

# -----------------------------------------------------------------------------
# Helper Functions
# -----------------------------------------------------------------------------
print_test() {
  printf '%-40s' "$1"
}

print_pass() {
  printf '%bPASS%b\n' "${GREEN}" "${NC}"
}

print_fail() {
  printf '%bFAIL%b\n' "${RED}" "${NC}"
  FAILURES=$((FAILURES + 1))
}

print_skip() {
  printf '%bSKIP%b (%s)\n' "${YELLOW}" "${NC}" "$1"
}

# -----------------------------------------------------------------------------
# Tests
# -----------------------------------------------------------------------------
printf '=== Script Validation Tests ===\n'
printf '\n'

# Test 1: Bash syntax check
print_test "Bash syntax check..."
SYNTAX_ERRORS=0
for script in "${SCRIPT_DIR}"/*.sh; do
  if [[ "$(basename "${script}")" == "test-scripts.sh" ]]; then
    continue
  fi
  if ! bash -n "${script}" 2>/dev/null; then
    SYNTAX_ERRORS=$((SYNTAX_ERRORS + 1))
    printf '\n  Syntax error in: %s\n' "${script}" >&2
  fi
done
if [[ ${SYNTAX_ERRORS} -eq 0 ]]; then
  print_pass
else
  print_fail
fi

# Test 2: Shellcheck validation
print_test "Shellcheck analysis..."
if command -v shellcheck >/dev/null 2>&1; then
  SHELLCHECK_OUTPUT=""
  for script in "${SCRIPT_DIR}"/*.sh; do
    if [[ "$(basename "${script}")" == "test-scripts.sh" ]]; then
      continue
    fi
    if ! OUTPUT=$(shellcheck --shell=bash "${script}" 2>&1); then
      SHELLCHECK_OUTPUT="${SHELLCHECK_OUTPUT}\n${OUTPUT}"
    fi
  done
  if [[ -z "${SHELLCHECK_OUTPUT}" ]]; then
    print_pass
  else
    print_fail
    printf '%b\n' "${SHELLCHECK_OUTPUT}" >&2
  fi
else
  print_skip "shellcheck not installed"
fi

# Test 3: Shfmt formatting check
print_test "Shfmt formatting..."
if command -v shfmt >/dev/null 2>&1; then
  SHFMT_ERRORS=0
  for script in "${SCRIPT_DIR}"/*.sh; do
    if [[ "$(basename "${script}")" == "test-scripts.sh" ]]; then
      continue
    fi
    if ! shfmt -d -i 2 -ci "${script}" >/dev/null 2>&1; then
      SHFMT_ERRORS=$((SHFMT_ERRORS + 1))
      printf '\n  Formatting issue in: %s\n' "${script}" >&2
    fi
  done
  if [[ ${SHFMT_ERRORS} -eq 0 ]]; then
    print_pass
  else
    print_fail
    printf '  Run: shfmt -i 2 -ci -w %s/*.sh\n' "${SCRIPT_DIR}" >&2
  fi
else
  print_skip "shfmt not installed"
fi

# Test 4: Strict mode check
print_test "Strict mode (set -euo pipefail)..."
STRICT_ERRORS=0
for script in "${SCRIPT_DIR}"/*.sh; do
  if [[ "$(basename "${script}")" == "test-scripts.sh" ]]; then
    continue
  fi
  if ! grep -q 'set -euo pipefail' "${script}"; then
    STRICT_ERRORS=$((STRICT_ERRORS + 1))
    printf '\n  Missing strict mode: %s\n' "${script}" >&2
  fi
done
if [[ ${STRICT_ERRORS} -eq 0 ]]; then
  print_pass
else
  print_fail
fi

# Test 5: Shebang check
print_test "Portable shebang..."
SHEBANG_ERRORS=0
for script in "${SCRIPT_DIR}"/*.sh; do
  if [[ "$(basename "${script}")" == "test-scripts.sh" ]]; then
    continue
  fi
  FIRST_LINE="$(head -1 "${script}")"
  if [[ "${FIRST_LINE}" != "#!/usr/bin/env bash" ]]; then
    SHEBANG_ERRORS=$((SHEBANG_ERRORS + 1))
    printf '\n  Non-portable shebang in: %s\n' "${script}" >&2
    printf '    Found: %s\n' "${FIRST_LINE}" >&2
    printf '    Expected: #!/usr/bin/env bash\n' >&2
  fi
done
if [[ ${SHEBANG_ERRORS} -eq 0 ]]; then
  print_pass
else
  print_fail
fi

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
printf '\n'
printf '=========================================\n'
if [[ ${FAILURES} -eq 0 ]]; then
  printf '%bAll tests passed!%b\n' "${GREEN}" "${NC}"
  exit 0
else
  printf '%b%d test(s) failed%b\n' "${RED}" "${FAILURES}" "${NC}"
  exit 1
fi
