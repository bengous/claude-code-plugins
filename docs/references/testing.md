# Testing & Debugging

[← Back to Main Guide](../../CLAUDE.md)

How to develop, test, and debug plugins locally.

## Local Development Workflow

**No build step required!**

1. Create plugin in repository
2. Open Claude Code from repository root
3. Commands automatically available
4. Make changes to commands/scripts
5. Changes take effect immediately

## Direct Script Testing

```bash
# Scripts discover repository from current directory
cd /path/to/test-repo
/path/to/plugin/scripts/feature/script list --json

# Disable locks for testing
SCRIPT_LOCK=false /path/to/plugin/scripts/feature/script create test
```

## State Inspection

```bash
# View metadata
cat .myplugin/meta/item.json | jq

# View locks
cat .myplugin/locks/item.lock | jq

# View logs
cat .myplugin/logs/item.log
```

## Diagnostic Commands

Build health check commands:

```bash
doctor_command() {
  local issues=0
  for file in "$META_DIR"/*.json; do
    name="$(basename "$file" .json)"
    # Validate metadata
    if ! jq empty "$file" 2>/dev/null; then
      echo "Invalid JSON: $name"
      ((issues++))
    fi
  done

  if [[ "$issues" -eq 0 ]]; then
    echo "✓ All items healthy"
  else
    echo "✗ $issues issue(s) detected"
  fi
}
```

## Debugging Tools

- `claude --debug`: See plugin loading, command registration
- `/help`: Verify commands appear
- Manual script execution: Test before hooking to Claude

---

**Related:**
- [Quick Start](./quickstart.md) - First plugin tutorial
- [Scripts Guide](./scripts.md) - Script patterns
- [Pitfalls](./pitfalls.md) - Common mistakes
