#!/usr/bin/env bash
# Track Claude Code version changes across sessions
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
VERSION_FILE="$REPO_ROOT/.claude-version"
CURRENT=$(claude --version 2>/dev/null | head -1 || echo 'unknown')

if [[ -f "$VERSION_FILE" ]]; then
  PREVIOUS=$(cat "$VERSION_FILE")
  if [[ "$CURRENT" != "$PREVIOUS" ]]; then
    echo "Claude version changed: $PREVIOUS -> $CURRENT"
    echo "Consider running /dump-system-prompt to track prompt changes"
    echo "$CURRENT" >"$VERSION_FILE"
  fi
else
  echo "$CURRENT" >"$VERSION_FILE"
  echo "Initialized version tracking: $CURRENT"
fi
