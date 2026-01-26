#!/usr/bin/env bash
# Block AI signatures in commit messages
set -euo pipefail

COMMIT_MSG_FILE="$1"
COMMIT_MSG=$(cat "$COMMIT_MSG_FILE")

has_ai_signature() {
  local msg="$1"
  echo "$msg" | grep -qE "Co-Authored-By:.*(<[^>]*@(anthropic|openai)\.com>|.*(Claude|ChatGPT|Copilot|Codex|Gemini|Tabnine|Codeium))" 2>/dev/null && return 0
  echo "$msg" | grep -qE "(🤖|🤯).*(Generated|Written|Powered|Created) with" 2>/dev/null && return 0
  echo "$msg" | grep -qE "(Generated|Written|Powered|Created) with \[.*\]" 2>/dev/null && return 0
  echo "$msg" | grep -qE "^[[:space:]]*AI-?generated[[:space:]]*$" 2>/dev/null && return 0
  return 1
}

if has_ai_signature "$COMMIT_MSG"; then
  [[ "${GIT_NO_AI_HOOK:-0}" == "1" ]] && exit 0
  [[ "$(git config --get hooks.allowAISignatures 2>/dev/null)" == "true" ]] && exit 0
  echo "BLOCKED: AI signature detected in commit message"
  echo "Bypass: GIT_NO_AI_HOOK=1 git commit"
  exit 1
fi
