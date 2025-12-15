---
paths: "**/scripts/**"
---

# Script Patterns

Comprehensive patterns for implementing plugin backend scripts.

## Standard Script Header

```bash
#!/usr/bin/env bash
set -euo pipefail

# === Dependencies ===
command -v jq >/dev/null 2>&1 || { echo "Error: jq required" >&2; exit 1; }
command -v gh >/dev/null 2>&1 || { echo "Error: gh CLI required" >&2; exit 1; }

# === Repository Discovery (NEVER hardcode paths) ===
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Error: Not in a git repository" >&2
  exit 1
}
cd "$REPO_ROOT"

# === State Directory (repository-scoped, NOT global) ===
STATE_DIR="$REPO_ROOT/.myplugin"
mkdir -p "$STATE_DIR"
```

**Why this pattern:**
- `set -euo pipefail` - Fail fast on errors, undefined vars, pipe failures
- Early dependency checks with actionable error messages
- `git rev-parse --show-toplevel` - Works from any subdirectory, no hardcoded paths
- State in `$REPO_ROOT/.myplugin` - Repository-scoped, not global `$HOME`

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
```

## Error Handling

```bash
# Always: stderr, descriptive message, non-zero exit
echo "Error: Could not find issue #${issue_number}" >&2
echo "Run 'gh issue list' to see available issues" >&2
exit 1
```

**Error message guidelines:**
- Start with `"Error: "`
- Explain what went wrong
- Suggest how to fix (when applicable)
- Use stderr (`>&2`)
- Exit with non-zero code

## Atomic Writes (CRITICAL)

```bash
# WRONG - corrupts file if interrupted
jq '.status = "done"' file.json > file.json

# RIGHT - atomic operation
jq '.status = "done"' file.json > file.json.tmp
mv file.json.tmp file.json
```

**Why atomic:** If the script is interrupted mid-write, direct overwrites corrupt the file. Temp file + mv is atomic on POSIX systems.

## Subcommand Router

```bash
COMMAND="${1:-list}"
shift || true

case "$COMMAND" in
  list)   list_items "$@" ;;
  create) create_item "$@" ;;
  delete) delete_item "$@" ;;
  *)
    echo "Error: Unknown command: $COMMAND" >&2
    echo "Available: list, create, delete" >&2
    exit 1
    ;;
esac
```

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

# State Management

## Repository-Scoped State

Two conventions exist in production plugins:

```bash
# Convention A: Inside .claude/ directory (used by git-tools)
STATE_DIR="$REPO_ROOT/.claude/myplugin"

# Convention B: Top-level hidden directory
STATE_DIR="$REPO_ROOT/.myplugin"

# WRONG - global state affects all repositories
STATE_DIR="$HOME/.myplugin"
```

**Why repository-scoped:** Global state causes cross-repository contamination. Plugin state should be isolated per project.

**Note:** Add your state directory to `.gitignore`:
```bash
echo ".myplugin/" >> .gitignore
```

## Per-Item Files

```bash
# RIGHT - one file per item (concurrent-safe)
.myplugin/meta/item-1.json
.myplugin/meta/item-2.json

# WRONG - monolithic state file (race conditions)
.myplugin/state.json  # Everything in one file
```

**Why per-item:** Monolithic files have race conditions when multiple processes update simultaneously. Per-item files are naturally concurrent-safe.

## JSON State with jq

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

**Why jq:** String concatenation like `echo "{\"name\": \"$name\"}"` breaks on special characters. jq handles escaping correctly.

---

# Architectural Patterns

## Pattern: Command → Script Delegation

**Why:** Separation of concerns, testability, reusability

```markdown
# Command delegates to script
**Your task:** Execute `<plugin-location>/scripts/feature/script $ARGUMENTS`
```

```bash
# Script contains all logic
#!/usr/bin/env bash
set -euo pipefail
# ... implementation
```

## Pattern: Modular Libraries

**Why:** Testable, reusable, maintainable

```
scripts/feature/
├── feature          # Main router
└── lib/
    ├── ui.sh       # Display functions
    ├── logic.sh    # Business logic
    └── helpers.sh  # Utilities
```

```bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/ui.sh"
source "$SCRIPT_DIR/lib/logic.sh"
```

## Pattern: Lock with TTL

**Why:** Safe concurrency, automatic expiration

```bash
lock_with_ttl() {
  local name="$1"
  local ttl="${2:-6h}"
  local expires=$(date -u -d "$ttl" +"%Y-%m-%dT%H:%M:%SZ")

  jq -n --arg name "$name" --arg expires "$expires" '{
    name: $name,
    locked_at: now,
    expires_at: $expires
  }' > "$LOCK_DIR/${name}.lock"
}

is_locked() {
  local name="$1"
  local lock="$LOCK_DIR/${name}.lock"

  [[ ! -f "$lock" ]] && return 1

  local expires=$(jq -r '.expires_at' "$lock")
  local now=$(date -u +%s)
  local exp=$(date -d "$expires" +%s 2>/dev/null || echo 0)

  [[ "$exp" -gt "$now" ]]  # Returns 0 if still locked
}
```

## Pattern: Idempotent Operations

**Why:** Safe retries, user-friendly

```bash
create_or_get() {
  if existing=$(get_existing); then
    echo "Already exists: $existing"
    return 0
  fi
  create_new
}
```
