#!/usr/bin/env bash
# Sync .claude/__settings.jsonc to .claude/settings.json
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

SOURCE=".claude/__settings.jsonc"
TARGET=".claude/settings.json"

if [[ ! -f "$SOURCE" ]]; then
  echo "Error: $SOURCE not found" >&2
  exit 1
fi

# Validate before sync (with AI explanation on error)
export SETTINGS_AI_EXPLAIN=1
if command -v settings-manager &>/dev/null; then
  if ! settings-manager validate --source "$SOURCE"; then
    echo "Fix the validation errors above, then commit again."
    exit 1
  fi
fi

node -e '
  const fs = require("fs");
  const input = fs.readFileSync(process.argv[1], "utf8");
  let result = "", inString = false, i = 0;
  while (i < input.length) {
    if (!inString && input[i] === "\"") {
      inString = true; result += input[i]; i++; continue;
    }
    if (inString) {
      if (input[i] === "\\" && i + 1 < input.length) { result += input[i] + input[i+1]; i += 2; continue; }
      if (input[i] === "\"") inString = false;
      result += input[i]; i++; continue;
    }
    if (input[i] === "/" && i + 1 < input.length) {
      if (input[i+1] === "/") { while (i < input.length && input[i] !== "\n") i++; continue; }
      if (input[i+1] === "*") { i += 2; while (i+1 < input.length && !(input[i] === "*" && input[i+1] === "/")) i++; i += 2; continue; }
    }
    result += input[i]; i++;
  }
  const obj = JSON.parse(result);
  console.log(JSON.stringify(obj, null, 2));
' "$SOURCE" > "${TARGET}.tmp"

mv "${TARGET}.tmp" "$TARGET"
echo "Synced: $SOURCE -> $TARGET"
