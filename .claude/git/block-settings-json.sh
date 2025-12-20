#!/usr/bin/env bash
set -euo pipefail

if [[ "${SETTINGS_BYPASS:-}" == "1" ]]; then
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if git diff --cached --name-only | grep -q "^\.claude\/settings\.json$"; then
  if git diff --cached --name-only | grep -q "^\.claude\/__settings\.jsonc$"; then
    exit 0
  fi

  echo ""
  echo "ERROR: Direct edits to .claude/settings.json are blocked."
  echo ""
  echo "Edit .claude/__settings.jsonc instead (supports comments)."
  echo ""
  echo "Bypass (emergency only):"
  echo "  SETTINGS_BYPASS=1 git commit -m \"...\""
  echo ""
  exit 1
fi
