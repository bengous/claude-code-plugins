#!/usr/bin/env bash
set -euo pipefail

# Marketplace validation script
# Validates marketplace.json against individual plugin.json files

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Error: Not in a git repository" >&2
  exit 2
}
cd "$REPO_ROOT"

MARKETPLACE_FILE=".claude-plugin/marketplace.json"
ERRORS=0

# Colors (disabled if not a terminal)
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  BOLD='\033[1m'
  RESET='\033[0m'
else
  GREEN=''
  RED=''
  BOLD=''
  RESET=''
fi

pass() { echo -e "  ${GREEN}✓${RESET} $1"; }
fail() { echo -e "  ${RED}✗${RESET} $1"; ((ERRORS++)); }

# Check dependencies
if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not installed" >&2
  echo "Install with: pacman -S jq (or your package manager)" >&2
  exit 2
fi

# Check marketplace.json exists
if [[ ! -f "$MARKETPLACE_FILE" ]]; then
  echo "Error: $MARKETPLACE_FILE not found" >&2
  exit 2
fi

# Validate marketplace.json is valid JSON
if ! jq empty "$MARKETPLACE_FILE" 2>/dev/null; then
  echo "Error: $MARKETPLACE_FILE is not valid JSON" >&2
  exit 2
fi

echo -e "${BOLD}Validating marketplace plugins...${RESET}"
echo ""

# Get plugin count
PLUGIN_COUNT=$(jq '.plugins | length' "$MARKETPLACE_FILE")

for i in $(seq 0 $((PLUGIN_COUNT - 1))); do
  # Extract marketplace entry data
  MP_NAME=$(jq -r ".plugins[$i].name" "$MARKETPLACE_FILE")
  MP_SOURCE=$(jq -r ".plugins[$i].source" "$MARKETPLACE_FILE")
  MP_VERSION=$(jq -r ".plugins[$i].version // empty" "$MARKETPLACE_FILE")
  MP_DESC=$(jq -r ".plugins[$i].description // empty" "$MARKETPLACE_FILE")

  echo -e "${BOLD}$MP_NAME${RESET}"

  # Check 1: Plugin directory exists
  if [[ -d "$MP_SOURCE" ]]; then
    pass "Directory exists: $MP_SOURCE"
  else
    fail "Directory missing: $MP_SOURCE"
    echo ""
    continue
  fi

  PLUGIN_JSON="$MP_SOURCE/.claude-plugin/plugin.json"

  # Check 2: plugin.json exists
  if [[ -f "$PLUGIN_JSON" ]]; then
    pass "plugin.json exists"
  else
    fail "plugin.json missing: $PLUGIN_JSON"
    echo ""
    continue
  fi

  # Validate plugin.json is valid JSON
  if ! jq empty "$PLUGIN_JSON" 2>/dev/null; then
    fail "plugin.json is not valid JSON"
    echo ""
    continue
  fi

  # Extract plugin.json data
  PL_NAME=$(jq -r '.name // empty' "$PLUGIN_JSON")
  PL_VERSION=$(jq -r '.version // empty' "$PLUGIN_JSON")
  PL_DESC=$(jq -r '.description // empty' "$PLUGIN_JSON")

  # Check 3: Name matches
  if [[ "$MP_NAME" == "$PL_NAME" ]]; then
    pass "Name matches"
  else
    fail "Name mismatch: marketplace=$MP_NAME, plugin=$PL_NAME"
  fi

  # Check 4: Version synced
  if [[ -z "$MP_VERSION" ]]; then
    fail "Version missing in marketplace.json"
  elif [[ -z "$PL_VERSION" ]]; then
    fail "Version missing in plugin.json"
  elif [[ "$MP_VERSION" == "$PL_VERSION" ]]; then
    pass "Version synced ($MP_VERSION)"
  else
    fail "Version mismatch: marketplace=$MP_VERSION, plugin=$PL_VERSION"
  fi

  # Check 5: Required fields present
  MISSING_FIELDS=()
  [[ -z "$MP_NAME" ]] && MISSING_FIELDS+=("marketplace:name")
  [[ -z "$MP_VERSION" ]] && MISSING_FIELDS+=("marketplace:version")
  [[ -z "$MP_DESC" ]] && MISSING_FIELDS+=("marketplace:description")
  [[ -z "$PL_NAME" ]] && MISSING_FIELDS+=("plugin:name")
  [[ -z "$PL_VERSION" ]] && MISSING_FIELDS+=("plugin:version")
  [[ -z "$PL_DESC" ]] && MISSING_FIELDS+=("plugin:description")

  if [[ ${#MISSING_FIELDS[@]} -eq 0 ]]; then
    pass "Required fields present"
  else
    fail "Missing fields: ${MISSING_FIELDS[*]}"
  fi

  echo ""
done

# Summary
echo "─────────────────────────────"
if [[ $ERRORS -eq 0 ]]; then
  echo -e "${GREEN}All checks passed.${RESET}"
  exit 0
else
  echo -e "${RED}$ERRORS error(s) found.${RESET}"
  exit 1
fi
