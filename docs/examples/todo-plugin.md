# Complete Example: TODO Plugin

[← Back to Main Guide](../../.claude/CLAUDE.md)

A complete, working example of a simple TODO list management plugin.

## Directory Structure

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

## plugin.json

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

## commands/todo.md

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

## commands/todo/add.md

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

## scripts/todo/todo

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

## Usage

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
