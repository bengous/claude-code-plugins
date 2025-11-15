# State Management Best Practices

[← Back to Main Guide](../../CLAUDE.md)

Patterns for safe, concurrent state management in plugin scripts.

## ✓ DO: Repository-Scoped State

```bash
STATE_DIR="$REPO_ROOT/.myplugin"
mkdir -p "$STATE_DIR/meta" "$STATE_DIR/locks"
```

## ✗ DON'T: Global State

```bash
# WRONG - affects all repositories
STATE_DIR="$HOME/.myplugin"
STATE_DIR="$HOME/.claude/myplugin"
```

## ✓ DO: Per-Item Files

```bash
# One file per item
.myplugin/meta/item-1.json
.myplugin/meta/item-2.json
.myplugin/meta/item-3.json
```

## ✗ DON'T: Monolithic State

```bash
# WRONG - hard to manage, race conditions
.myplugin/state.json  # All items in one file
```

## ✓ DO: Atomic Writes

```bash
tmp="${file}.tmp"
jq '.status = "active"' "$file" > "$tmp"
mv "$tmp" "$file"  # Atomic operation
```

## ✗ DON'T: Direct Overwrites

```bash
# WRONG - can corrupt file if interrupted
jq '.status = "active"' state.json > state.json
```

---

**Related:**
- [Scripts Guide](./scripts.md) - JSON state management helpers
- [Patterns](./patterns.md) - Lock with TTL pattern
- [Pitfalls](./pitfalls.md) - Common state management mistakes
