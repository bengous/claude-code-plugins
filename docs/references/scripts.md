# Script Implementation

[← Back to Main Guide](../../CLAUDE.md)

Comprehensive patterns and best practices for implementing plugin backend scripts.

## Standard Script Header

```bash
#!/usr/bin/env bash
set -euo pipefail

# Check dependencies
if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required for this command" >&2
  exit 1
fi

# Discover repository (NOT hardcoded path)
if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "Error: Not in a git repository" >&2
  echo "Run this command from within a git repository" >&2
  exit 1
fi
cd "$REPO_ROOT"
```

**Why this pattern:**
- `set -euo pipefail`: Fail fast on errors, undefined vars, pipe failures
- Early dependency checks with actionable error messages
- Dynamic repository discovery (works from any subdirectory)
- Change to repo root for consistent context

## Mutex Locking (for concurrent operations)

```bash
SCRIPT_LOCK="${SCRIPT_LOCK:-true}"

if [[ "$SCRIPT_LOCK" == "true" ]]; then
  LOCK_FILE="${TMPDIR:-/tmp}/my-script-${USER:-$(id -un)}.lock"
  exec 200>"$LOCK_FILE"
  if ! flock -x -w 60 200; then
    echo "Error: Could not acquire lock (timeout after 60s)" >&2
    echo "Another instance may be running" >&2
    exit 1
  fi
fi
```

Can be disabled for testing: `SCRIPT_LOCK=false /plugin:command`

## Error Handling

```bash
# Always write errors to stderr
echo "Error: descriptive message about what failed" >&2
exit 1
```

**Error message guidelines:**
- Start with `"Error: "`
- Explain what went wrong
- Suggest how to fix (when applicable)
- Use stderr (`>&2`)
- Exit with non-zero code

## Color Coding

```bash
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m'  # No Color

echo -e "${GREEN}✓ Success${NC}"
echo -e "${RED}✗ Error${NC}"
echo -e "${YELLOW}⚠ Warning${NC}"
echo -e "${BLUE}Info${NC}"
```

## JSON State Management

```bash
STATE_DIR="$REPO_ROOT/.myplugin"
META_DIR="$STATE_DIR/meta"
mkdir -p "$META_DIR"

# Helper functions
meta_path() {
  echo "$META_DIR/${1}.json"
}

write_meta() {
  local name="$1"
  local content="$2"
  printf '%s\n' "$content" > "$(meta_path "$name")"
}

load_meta() {
  cat "$(meta_path "$1")"
}

update_meta() {
  local name="$1"
  shift
  local file="$(meta_path "$name")"
  local tmp="${file}.tmp"
  jq "$@" "$file" > "$tmp"
  mv "$tmp" "$file"  # Atomic write
}
```

**Usage:**
```bash
# Create metadata
meta=$(jq -n --arg name "foo" '{name: $name, created: now}')
write_meta "foo" "$meta"

# Read metadata
data=$(load_meta "foo")
echo "$data" | jq '.name'

# Update metadata (atomic)
update_meta "foo" '.status = "active"'
```

## Argument Parsing

```bash
name=""
flag=""
option="default"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --flag)
      flag="true"
      shift
      ;;
    --option)
      option="$2"
      shift 2
      ;;
    *)
      if [[ -z "$name" ]]; then
        name="$1"
      fi
      shift
      ;;
  esac
done
```

## Subcommand Router

```bash
COMMAND="${1:-list}"
shift || true

case "$COMMAND" in
  list)
    list_command "$@"
    ;;
  create)
    create_command "$@"
    ;;
  delete)
    delete_command "$@"
    ;;
  *)
    echo "Error: unknown command: $COMMAND" >&2
    echo "Available: list, create, delete" >&2
    exit 1
    ;;
esac
```

## Name Slugification

For user input that becomes file/branch names:

```bash
slugify() {
  local input="$1"
  [[ -z "$input" ]] && echo "" && return

  python - "$input" <<'PY'
import re, sys, unicodedata
text = sys.argv[1]
text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
text = re.sub(r'[^a-zA-Z0-9]+', '-', text).strip('-').lower()
print(text)
PY
}
```

**Why Python:** Bash lacks Unicode normalization. This handles international characters correctly.

---

**Related:**
- [State Management](./state.md) - Best practices for plugin state
- [Patterns](./patterns.md) - Common architectural patterns
- [Pitfalls](./pitfalls.md) - Avoid common mistakes
