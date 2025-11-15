# Architectural Patterns

[← Back to Main Guide](../../CLAUDE.md)

Reusable architectural patterns for robust plugin development.

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

## Pattern: Subcommand Router

**Why:** Single script handles related operations

```bash
COMMAND="${1:-list}"
shift || true

case "$COMMAND" in
  list) list_command "$@" ;;
  create) create_command "$@" ;;
  delete) delete_command "$@" ;;
  *) echo "Unknown command" >&2; exit 1 ;;
esac
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

---

**Related:**
- [Scripts Guide](./scripts.md) - Implementation details
- [State Management](./state.md) - State patterns
- [Examples](../examples/todo-plugin.md) - Working examples
