#!/usr/bin/env bash
# Verify repo setup: mise → lefthook → hooks → submodules
# Usage: ./setup-check.sh [--quiet]
# Exit 0 if OK, exit 1 if setup needed (prints instructions)
set -euo pipefail

QUIET="${1:-}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
ERRORS=()

# Check mise
if ! command -v mise &>/dev/null; then
  ERRORS+=("mise not installed → https://mise.jdx.dev")
fi

# Check mise tools installed
if command -v mise &>/dev/null && [[ -f "$REPO_ROOT/mise.toml" ]]; then
  if ! mise which lefthook &>/dev/null; then
    ERRORS+=("mise tools not installed → run: mise install")
  fi
fi

# Check lefthook hooks installed
if command -v lefthook &>/dev/null || mise which lefthook &>/dev/null; then
  if [[ ! -f "$REPO_ROOT/.git/hooks/pre-commit" ]] || ! grep -q "lefthook" "$REPO_ROOT/.git/hooks/pre-commit" 2>/dev/null; then
    ERRORS+=("lefthook hooks not installed → run: lefthook install")
  fi
fi

# Check submodules initialized
if git submodule status 2>/dev/null | grep -q '^-'; then
  ERRORS+=("submodules not initialized → run: git submodule update --init --recursive")
fi

# Report
if [[ ${#ERRORS[@]} -gt 0 ]]; then
  echo "Setup incomplete:"
  for err in "${ERRORS[@]}"; do
    echo "  - $err"
  done
  echo ""
  echo "Quick fix: mise install && lefthook install && git submodule update --init --recursive"
  exit 1
fi

[[ "$QUIET" != "--quiet" ]] && echo "Setup OK"
exit 0
