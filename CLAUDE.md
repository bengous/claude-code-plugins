# Claude Code Plugin Development Guide

This repository is a **plugin marketplace** for Claude Code. This guide teaches you how to create, test, and distribute plugins.

> **Note:** For documentation on specific plugins (orchestration, git-tools), see their individual README files.

---

## Core Principle: Keep It Simple

**DO NOT OVER-ENGINEER.** Start minimal. If it's more than 250 lines, simplify. Agent is smart, user provides strategy in external files.

---

## Quick Start: Create Your First Plugin

### 1. Create Directory Structure

```bash
mkdir -p my-plugin/.claude-plugin
mkdir -p my-plugin/commands
mkdir -p my-plugin/scripts/mycommand
```

### 2. Create Plugin Manifest

**my-plugin/.claude-plugin/plugin.json:**
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "My first Claude Code plugin",
  "author": {
    "name": "Your Name",
    "email": "you@email.com"
  },
  "license": "MIT",
  "keywords": ["example"]
}
```

### 3. Create a Command

**my-plugin/commands/hello.md:**
```markdown
---
description: Say hello to the user
argument-hint: [name]
allowed-tools:
  - Bash(*:*)
---

Simple hello command.

**Plugin location:** !`realpath ~/.claude/plugins/marketplaces/your-marketplace/my-plugin 2>/dev/null || echo "$HOME/dev/my-plugin"`

Execute: `<plugin-location>/scripts/mycommand/mycommand hello $ARGUMENTS`
```

### 4. Create Backend Script

**my-plugin/scripts/mycommand/mycommand:**
```bash
#!/usr/bin/env bash
set -euo pipefail

GREEN='\033[0;32m'
NC='\033[0m'

COMMAND="${1:-hello}"
shift || true

case "$COMMAND" in
  hello)
    name="${1:-World}"
    echo -e "${GREEN}Hello, $name!${NC}"
    ;;
  *)
    echo "Error: unknown command: $COMMAND" >&2
    exit 1
    ;;
esac
```

Make it executable: `chmod +x my-plugin/scripts/mycommand/mycommand`

### 5. Test Locally

```bash
cd /any/repository
/hello           # Output: Hello, World!
/hello Alice     # Output: Hello, Alice!
```

Claude Code automatically detects plugins in your repository. No build step required!

---

## Plugin Structure

### Required Files

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json              # REQUIRED - Plugin manifest
├── commands/                    # REQUIRED - At least one command
│   ├── main.md                 # Root command: /main
│   └── subcommand/             # Subcommands: /main:action
│       └── action.md
├── scripts/                     # Backend implementation
│   └── category/
│       └── script              # Executable shell script
├── README.md                    # REQUIRED - Plugin documentation
└── LICENSE                      # REQUIRED - License file
```

### Optional Directories

```
├── hooks/                       # Safety/workflow enforcement
│   ├── hooks.json
│   └── guard.py
├── agents/                      # Subagent templates
│   └── specialist.md
└── skills/                      # Agent skills
    └── analyzer/
        └── SKILL.md
```

### Critical Rules

- **Only `plugin.json` goes in `.claude-plugin/`**
- All other directories (`commands/`, `scripts/`, etc.) must be at plugin root
- Versions in `marketplace.json` and `plugin.json` must match
- All scripts must be executable (`chmod +x`)

---

## Command Development

### Frontmatter Structure

```markdown
---
description: Brief description for command palette
argument-hint: <required> [optional] [--flag]
allowed-tools:
  - Bash(*:*)                                    # Unrestricted bash
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/*":*)   # Restricted path
  - Read(*:*)
  - Grep(*:*)
model: claude-sonnet-4-5                         # Override default model
---

[Documentation for users - what the command does, examples]

[Instructions for Claude - how to execute the command]
```

### Path Resolution Patterns

**Pattern 1: Two-Stage Resolution** (works in both dev and marketplace)
```markdown
**Plugin location:** !`realpath ~/.claude/plugins/marketplaces/name/plugin 2>/dev/null || echo "$HOME/dev/plugin"`

Execute: `<plugin-location>/scripts/feature/script $ARGUMENTS`
```

**Pattern 2: Direct Environment Variable** (simpler)
```markdown
!"${CLAUDE_PLUGIN_ROOT}/scripts/feature/script" $ARGUMENTS
```

### Allowed-Tools Patterns

**Unrestricted (command delegates to trusted script):**
```yaml
allowed-tools:
  - Bash(*:*)
```

**Restricted (only specific script):**
```yaml
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/safe-script":*)
  - Read(*:*)
  - Grep(*:*)
```

**No tools (pure prompt):**
```yaml
allowed-tools: []
```

### Command Hierarchy

- `commands/feature.md` → `/feature`
- `commands/feature/create.md` → `/feature:create`
- `commands/feature/delete.md` → `/feature:delete`

Organize related commands in subdirectories.

---

## Script Implementation

### Standard Script Header

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

### Mutex Locking (for concurrent operations)

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

### Error Handling

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

### Color Coding

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

### JSON State Management

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

### Argument Parsing

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

### Subcommand Router

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

### Name Slugification

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

## Hook System

### Hook Registration

**hooks/hooks.json:**
```json
{
  "description": "Safety hooks for my plugin",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/guard.py",
            "timeout": 5,
            "description": "Blocks dangerous commands"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/workflow.sh",
            "timeout": 3,
            "description": "Enforces workflow rules"
          }
        ]
      }
    ]
  }
}
```

### Available Hook Events

| Hook | When | Use For |
|------|------|---------|
| `PreToolUse` | Before tool execution | Block dangerous commands |
| `PostToolUse` | After tool execution | Log operations, trigger follow-ups |
| `UserPromptSubmit` | User submits prompt | Enforce workflow rules |

### Hook Implementation

**hooks/guard.py:**
```python
#!/usr/bin/env python3
import json
import sys
import shlex

# Read payload from stdin
try:
    payload = json.load(sys.stdin)
except:
    sys.exit(0)  # Allow on parse failure

# Extract command
tool_input = payload.get("tool_input", {})
cmd = tool_input.get("command") if isinstance(tool_input, dict) else None

if not cmd:
    sys.exit(0)  # Allow if no command

# Parse command
argv = shlex.split(cmd) if isinstance(cmd, str) else cmd

# Block patterns
BLOCKED = [
    ("rm", "-rf", "/"),
    ("git", "push", "--force"),
]

for pattern in BLOCKED:
    if len(argv) >= len(pattern):
        if all(argv[i] == pattern[i] for i in range(len(pattern))):
            sys.stderr.write(f"🚫 Blocked dangerous command\n")
            sys.stderr.write(f"Use safe alternative instead\n")
            sys.exit(2)  # Exit 2 = block

sys.exit(0)  # Exit 0 = allow
```

### Hook Exit Codes

- **0**: Allow operation
- **2**: Block operation (stderr shown to user)
- **Other**: Error (stderr shown to user)

### Hook Bypass Pattern

**IMPORTANT:** Never expose bypass mechanisms to the model.

```bash
# In backend script (NOT in hook)
export GUARD_BYPASS=1
git push --force  # Hook checks GUARD_BYPASS and allows
```

**Why:** Models learn bypass patterns. Keep hooks strict. Only bypass in backend scripts.

---

## State Management Best Practices

### ✓ DO: Repository-Scoped State

```bash
STATE_DIR="$REPO_ROOT/.myplugin"
mkdir -p "$STATE_DIR/meta" "$STATE_DIR/locks"
```

### ✗ DON'T: Global State

```bash
# WRONG - affects all repositories
STATE_DIR="$HOME/.myplugin"
STATE_DIR="$HOME/.claude/myplugin"
```

### ✓ DO: Per-Item Files

```bash
# One file per item
.myplugin/meta/item-1.json
.myplugin/meta/item-2.json
.myplugin/meta/item-3.json
```

### ✗ DON'T: Monolithic State

```bash
# WRONG - hard to manage, race conditions
.myplugin/state.json  # All items in one file
```

### ✓ DO: Atomic Writes

```bash
tmp="${file}.tmp"
jq '.status = "active"' "$file" > "$tmp"
mv "$tmp" "$file"  # Atomic operation
```

### ✗ DON'T: Direct Overwrites

```bash
# WRONG - can corrupt file if interrupted
jq '.status = "active"' state.json > state.json
```

---

## Testing & Debugging

### Local Development Workflow

**No build step required!**

1. Create plugin in repository
2. Open Claude Code from repository root
3. Commands automatically available
4. Make changes to commands/scripts
5. Changes take effect immediately

### Direct Script Testing

```bash
# Scripts discover repository from current directory
cd /path/to/test-repo
/path/to/plugin/scripts/feature/script list --json

# Disable locks for testing
SCRIPT_LOCK=false /path/to/plugin/scripts/feature/script create test
```

### State Inspection

```bash
# View metadata
cat .myplugin/meta/item.json | jq

# View locks
cat .myplugin/locks/item.lock | jq

# View logs
cat .myplugin/logs/item.log
```

### Diagnostic Commands

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

### Debugging Tools

- `claude --debug`: See plugin loading, command registration
- `/help`: Verify commands appear
- Manual script execution: Test before hooking to Claude

---

## Common Pitfalls

### ✗ Hardcoded Paths

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

### ✗ Global State Storage

```bash
# WRONG
STATE="$HOME/.myplugin/state"
```

```bash
# RIGHT
STATE="$REPO_ROOT/.myplugin"
```

### ✗ Exposing Hook Bypasses

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

### ✗ String Concatenation for JSON

```bash
# WRONG - breaks on quotes
echo "{\"name\": \"$name\"}" > file.json
```

```bash
# RIGHT - jq handles escaping
jq -n --arg name "$name" '{name: $name}' > file.json
```

### ✗ Non-Atomic File Writes

```bash
# WRONG - race condition
jq '.status = "done"' file.json > file.json
```

```bash
# RIGHT - atomic
jq '.status = "done"' file.json > file.json.tmp
mv file.json.tmp file.json
```

### ✗ Version Desync

```json
# marketplace.json
"version": "1.0.0"

# plugin.json
"version": "1.0.1"  # WRONG - must match!
```

### ✗ Forgetting Model Specification

```yaml
# RISKY - may use Haiku for complex task
description: Complex multi-step orchestration
```

```yaml
# RIGHT - specify Sonnet for complex tasks
description: Complex multi-step orchestration
model: claude-sonnet-4-5
```

### ✗ Non-Idempotent Operations

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

## Architectural Patterns

### Pattern: Command → Script Delegation

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

### Pattern: Subcommand Router

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

### Pattern: Modular Libraries

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

### Pattern: Lock with TTL

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

### Pattern: Idempotent Operations

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

## Marketplace Distribution

### Adding Plugin to Marketplace

**.claude-plugin/marketplace.json:**
```json
{
  "name": "my-marketplace",
  "owner": {
    "name": "Your Name",
    "email": "you@email.com"
  },
  "plugins": [
    {
      "name": "my-plugin",
      "description": "Plugin description",
      "version": "1.0.0",
      "author": {
        "name": "Your Name",
        "email": "you@email.com"
      },
      "homepage": "https://github.com/you/plugins",
      "license": "MIT",
      "keywords": ["keyword1", "keyword2"],
      "source": "./my-plugin"
    }
  ]
}
```

### Version Synchronization

**CRITICAL:** Both versions must match!

```json
# .claude-plugin/marketplace.json
{
  "plugins": [{
    "name": "my-plugin",
    "version": "1.0.0"  # ← Must match
  }]
}

# my-plugin/.claude-plugin/plugin.json
{
  "name": "my-plugin",
  "version": "1.0.0"  # ← Must match
}
```

### Installation

Users add your marketplace:

```bash
/plugin marketplace add your-github-user/plugin-repo
/plugin install my-plugin@my-marketplace
```

Or for team installations, add to `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "team-tools": {
      "source": {
        "source": "github",
        "repo": "your-org/plugins"
      }
    }
  },
  "enabledPlugins": ["my-plugin@team-tools"]
}
```

---

## Complete Example: TODO Plugin

### Directory Structure

```
todo-plugin/
├── .claude-plugin/
│   └── plugin.json
├── commands/
│   ├── todo.md
│   └── todo/
│       ├── add.md
│       ├── list.md
│       └── done.md
├── scripts/
│   └── todo/
│       └── todo
├── README.md
└── LICENSE
```

### plugin.json

```json
{
  "name": "todo-plugin",
  "version": "1.0.0",
  "description": "Simple TODO list management",
  "author": {
    "name": "Your Name",
    "email": "you@email.com"
  },
  "license": "MIT",
  "keywords": ["todo", "tasks"]
}
```

### commands/todo.md

```markdown
---
description: Manage TODO items
argument-hint: [command]
allowed-tools:
  - Bash(*:*)
---

TODO list management.

**Usage:**
- `/todo:add <task>` - Add task
- `/todo:list` - List all tasks
- `/todo:done <id>` - Mark task as done

**Plugin location:** !`realpath ~/.claude/plugins/marketplaces/*/todo-plugin 2>/dev/null || echo "$HOME/dev/todo-plugin"`

Execute: `<plugin-location>/scripts/todo/todo list $ARGUMENTS`
```

### commands/todo/add.md

```markdown
---
description: Add a TODO item
argument-hint: <task description>
allowed-tools:
  - Bash(*:*)
---

Add a new TODO item.

**Plugin location:** !`realpath ~/.claude/plugins/marketplaces/*/todo-plugin 2>/dev/null || echo "$HOME/dev/todo-plugin"`

Execute: `<plugin-location>/scripts/todo/todo add $ARGUMENTS`
```

### scripts/todo/todo

```bash
#!/usr/bin/env bash
set -euo pipefail

# Check dependencies
if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required" >&2
  exit 1
fi

# Discover repository
if ! REPO="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "Error: Not in a git repository" >&2
  exit 1
fi
cd "$REPO"

# State directory
STATE_DIR="$REPO/.todo"
mkdir -p "$STATE_DIR"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
GRAY='\033[0;90m'
NC='\033[0m'

# Add command
add_command() {
  local task="$*"
  if [[ -z "$task" ]]; then
    echo "Error: task description required" >&2
    exit 1
  fi

  # Generate ID
  local id=$(date +%s)

  # Create TODO item
  jq -n \
    --arg id "$id" \
    --arg task "$task" \
    --arg created "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    '{
      id: $id,
      task: $task,
      created: $created,
      done: false
    }' > "$STATE_DIR/${id}.json"

  echo -e "${GREEN}✓ Added TODO #${id}${NC}"
  echo "  $task"
}

# List command
list_command() {
  local files=("$STATE_DIR"/*.json)
  if [[ ! -e "${files[0]}" ]]; then
    echo "No TODO items"
    return
  fi

  echo "TODO Items:"
  for file in "${files[@]}"; do
    local item=$(cat "$file")
    local id=$(jq -r '.id' <<< "$item")
    local task=$(jq -r '.task' <<< "$item")
    local done=$(jq -r '.done' <<< "$item")

    if [[ "$done" == "true" ]]; then
      echo -e "${GRAY}  ✓ #${id}: ${task}${NC}"
    else
      echo -e "  ${YELLOW}○${NC} #${id}: ${task}"
    fi
  done
}

# Done command
done_command() {
  local id="$1"
  if [[ -z "$id" ]]; then
    echo "Error: task ID required" >&2
    exit 1
  fi

  local file="$STATE_DIR/${id}.json"
  if [[ ! -f "$file" ]]; then
    echo "Error: TODO #${id} not found" >&2
    exit 1
  fi

  # Update task
  local tmp="${file}.tmp"
  jq '.done = true' "$file" > "$tmp"
  mv "$tmp" "$file"

  local task=$(jq -r '.task' "$file")
  echo -e "${GREEN}✓ Completed: ${task}${NC}"
}

# Router
COMMAND="${1:-list}"
shift || true

case "$COMMAND" in
  add) add_command "$@" ;;
  list) list_command "$@" ;;
  done) done_command "$@" ;;
  *) echo "Error: unknown command: $COMMAND" >&2; exit 1 ;;
esac
```

Make it executable: `chmod +x todo-plugin/scripts/todo/todo`

### Usage

```bash
/todo:add Implement authentication
# ✓ Added TODO #1234567890

/todo:list
# TODO Items:
#   ○ #1234567890: Implement authentication

/todo:done 1234567890
# ✓ Completed: Implement authentication

/todo:list
# TODO Items:
#   ✓ #1234567890: Implement authentication
```

---

## Reference: Existing Plugins

This marketplace contains production plugins you can study:

- **orchestration/** - Advanced workflow orchestration with worktrees, issues, PRs, and multi-agent coordination
- **git-tools/** - Interactive git commands with AI assistance

Each has its own README and documentation. Use them as architectural reference when building your plugins.

---

## Key Takeaways

1. **Separate concerns**: Commands delegate to scripts
2. **Dynamic discovery**: No hardcoded paths
3. **Repository-scoped state**: Store in `.plugin-name/`, not global
4. **Safety through hooks**: Enforce patterns, prevent mistakes
5. **Atomic operations**: Use temp files + mv
6. **Clear conventions**: Colors, errors, structure
7. **Idempotency**: Safe to retry
8. **Testability**: Support local development

Follow these patterns to create robust, maintainable plugins that integrate seamlessly with Claude Code.
