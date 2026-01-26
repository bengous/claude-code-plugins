#!/usr/bin/env bash
set -euo pipefail

[[ "${SETTINGS_BYPASS:-}" == "1" ]] && exit 0

staged=$(git diff --cached --name-only)

if echo "$staged" | grep -q "^\.claude/settings\.json$"; then
  # Allow if __settings.jsonc is also staged (sync script ran)
  echo "$staged" | grep -q "^\.claude/__settings\.jsonc$" && exit 0

  echo ""
  echo "ERROR: Direct edits to .claude/settings.json are blocked."
  echo "Edit .claude/__settings.jsonc instead (supports comments)."
  echo "Bypass (emergency): SETTINGS_BYPASS=1 git commit -m \"...\""
  echo ""
  exit 1
fi
