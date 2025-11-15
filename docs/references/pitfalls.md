# Common Pitfalls

[← Back to Main Guide](../../CLAUDE.md)

Common mistakes in plugin development and how to avoid them.

## ✗ Hardcoded Paths

```bash
# WRONG
REPO="/home/user/projects/myrepo"
PLUGIN="/home/user/.claude/plugins/myplugin"
```

```bash
# RIGHT
REPO="$(git rev-parse --show-toplevel)"
PLUGIN="${CLAUDE_PLUGIN_ROOT}"  # Environment variable
```

## ✗ Global State Storage

```bash
# WRONG
STATE="$HOME/.myplugin/state"
```

```bash
# RIGHT
STATE="$REPO_ROOT/.myplugin"
```

## ✗ Exposing Hook Bypasses

```python
# WRONG - model will learn this!
if os.environ.get("BYPASS") == "1":
    sys.exit(0)
```

```bash
# RIGHT - set in backend script, not exposed
export GUARD_BYPASS=1
dangerous_operation
```

## ✗ String Concatenation for JSON

```bash
# WRONG - breaks on quotes
echo "{\"name\": \"$name\"}" > file.json
```

```bash
# RIGHT - jq handles escaping
jq -n --arg name "$name" '{name: $name}' > file.json
```

## ✗ Non-Atomic File Writes

```bash
# WRONG - race condition
jq '.status = "done"' file.json > file.json
```

```bash
# RIGHT - atomic
jq '.status = "done"' file.json > file.json.tmp
mv file.json.tmp file.json
```

## ✗ Version Desync

```json
# marketplace.json
"version": "1.0.0"

# plugin.json
"version": "1.0.1"  # WRONG - must match!
```

## ✗ Forgetting Model Specification

```yaml
# RISKY - may use Haiku for complex task
description: Complex multi-step orchestration
```

```yaml
# RIGHT - specify Sonnet for complex tasks
description: Complex multi-step orchestration
model: claude-sonnet-4-5
```

## ✗ Non-Idempotent Operations

```bash
# WRONG - fails on retry
create_item() {
  echo "$name" > "$STATE_DIR/$name"
}
```

```bash
# RIGHT - safe to retry
create_item() {
  if [[ -f "$STATE_DIR/$name" ]]; then
    echo "Item already exists: $name"
    return 0
  fi
  echo "$name" > "$STATE_DIR/$name"
}
```

---

**Related:**
- [State Management](./state.md) - Best practices
- [Scripts Guide](./scripts.md) - Proper patterns
- [Patterns](./patterns.md) - Idempotent operations
