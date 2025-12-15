# Claude Code Plugin Development Guide

This repository is a **plugin marketplace** for Claude Code.

<behavioral_requirements>
## Before You Do Anything

**ALWAYS investigate before implementing.** When asked to create or modify plugins:

1. **Read reference implementations first**
   - `git-tools/` - Production plugin with commands, scripts, state management
   - `orchestration/` - Advanced plugin with agents, skills, hooks, complex workflows
   - Examine their structure, patterns, and conventions before writing new code

2. **Search for existing patterns**
   - Use Grep/Glob to find similar functionality in existing plugins
   - Reuse proven patterns rather than inventing new ones
   - Check if the feature already exists before creating it

3. **Understand the component landscape**
   - Commands, hooks, agents, and skills serve different purposes
   - Choose the right component type BEFORE implementing (see Component Selection below)

**Never propose plugin changes without first reading the relevant existing code.**
</behavioral_requirements>

---

<core_principle>
## Core Principle: Keep It Simple

**DO NOT OVER-ENGINEER.** If the plugin you're building is getting complex, stop and report to the human. You may be overdoing it.

- Start with the minimal viable implementation
- Add complexity only when explicitly needed
- A 20-line script is better than a 200-line framework
- If you need more than 3 files for a simple command, reconsider
</core_principle>

---

<reference_implementations>
## Reference Implementations

**Read these before creating new plugins:**

| Plugin | Complexity | Learn From |
|--------|------------|------------|
| `git-tools/` | Medium | Commands with scripts, argument parsing, state management, GitHub integration |
| `orchestration/` | Advanced | Agents, skills, hooks, multi-agent coordination, complex workflows |

**To understand a pattern, read the actual code:**
```bash
# Example: See how git-tools handles commands
ls git-tools/commands/
cat git-tools/commands/issue.md

# Example: See how orchestration uses agents
ls orchestration/agents/
cat orchestration/agents/architect.md
```
</reference_implementations>

---

<plugin_anatomy>
## Plugin Anatomy

### Directory Structure

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json        # ONLY file allowed here (Claude Code loader requirement)
├── commands/
│   └── mycommand.md       # Slash commands (required: at least one)
├── scripts/
│   └── mycommand/
│       └── mycommand      # Backend implementation (executable bash)
├── hooks/                  # Optional: safety/workflow enforcement
│   └── hooks.json
├── agents/                 # Optional: subagent templates
├── skills/                 # Optional: agent skills
├── README.md
└── LICENSE
```

### plugin.json (Manifest)

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Brief description of what this plugin does",
  "author": {
    "name": "Your Name",
    "email": "you@email.com"
  },
  "homepage": "https://github.com/you/my-plugin",
  "repository": "https://github.com/you/my-plugin",
  "license": "MIT",
  "keywords": ["relevant", "keywords"]
}
```

**Why this structure:**
- `.claude-plugin/` contains ONLY `plugin.json` because Claude Code's plugin loader expects exactly one manifest file; additional files cause silent discovery failures
- `commands/` must have at least one command for the plugin to be useful
- `scripts/` separates backend logic from command definitions (separation of concerns)
</plugin_anatomy>

---

<component_selection>
## Component Selection Guide

**Choose the right component for your task:**

| Need | Component | When to Use |
|------|-----------|-------------|
| User-triggered action | **Command** | User types `/something` to start a workflow |
| Safety/enforcement | **Hook** | Block dangerous operations, enforce workflow rules |
| Autonomous subtask | **Agent** | Delegated work that runs independently with its own context |
| Reusable knowledge | **Skill** | Instructions/patterns agents can invoke for specialized tasks |

### Decision Tree

```
Is this triggered by the user typing a slash command?
├── YES → Command
└── NO → Does it need to intercept/block operations?
    ├── YES → Hook
    └── NO → Is it autonomous work delegated to a subagent?
        ├── YES → Agent
        └── NO → Is it reusable knowledge/instructions?
            ├── YES → Skill
            └── NO → Probably a script (called by command)
```

### When to Use Each

**Commands** - Entry points for user interaction
- `/analyze-git` - User wants git analysis
- `/issue` - User wants to create an issue

**Hooks** - Enforcement and safety
- Block `git push --force` on main branch
- Require issue reference in commit messages

**Agents** - Delegated autonomous work
- `architect` agent designs implementation approach
- `implementation` agent writes code based on plan

**Skills** - Specialized knowledge injection
- `layer-testing` skill knows how to test architectural layers
- Agents invoke skills when they need domain expertise
</component_selection>

---

<agent_patterns>
## Agent Patterns

Agents are **stateless subagents** that receive context once and return results. They run autonomously with their own context window.

### Agent Frontmatter

```markdown
---
description: Brief description of what this agent does
subagent-type: general-purpose
model: opus                    # or claude-opus-4-5, claude-sonnet-4-5
allowed-tools:
  - Read(*:*)
  - Grep(*:*)
  - Glob(*:*)
  - Bash(*:*)
---
```

**Model options:**
- `opus` or `claude-opus-4-5` - Complex reasoning, architecture, multi-step tasks
- `sonnet` or `claude-sonnet-4-5` - Simpler tasks, faster execution
- `haiku` - Quick, simple operations

### Agent Structure

```markdown
---
[frontmatter]
---

# Agent Name

## Context
[What this agent receives and its purpose]

## Responsibilities
1. First responsibility
2. Second responsibility

## Constraints
- What the agent must NOT do
- Boundaries to respect

## Return Format
[What the agent should output when done]
```

**See:** `orchestration/agents/architect.md` for a production example.
</agent_patterns>

---

<skill_patterns>
## Skill Patterns

Skills are **reusable knowledge modules** that agents can invoke for specialized tasks.

### Skill Structure

Skills live in `skills/<skill-name>/SKILL.md`:

```markdown
---
name: my-skill
description: |
  Multi-line description of what this skill does.
  When agents should invoke it.
allowed-tools:
  - Bash(*:*)
  - Read(*:*)
  - Grep(*:*)
---

# Skill Name

<context>
Why this skill exists and what problem it solves.
</context>

<constraints>
- Boundaries the skill enforces
- What it must NOT do
</constraints>

<workflow>
## Step 1: First Step
Instructions for this step.

## Step 2: Second Step
Instructions for this step.
</workflow>
```

### Skill Directory Structure

Complex skills can have supporting files:

```
skills/
└── layer-testing/
    ├── SKILL.md              # Main skill definition
    ├── references/           # Supporting documentation
    │   └── patterns.md
    └── templates/            # Reusable templates
        └── example.md
```

**See:** `orchestration/skills/layer-testing/SKILL.md` for a production example.
</skill_patterns>

---

<command_patterns>
## Command Patterns

### Command Frontmatter

```markdown
---
description: Brief description shown in command palette
argument-hint: <required> [optional] [--flag]
allowed-tools:
  - Bash(*:*)                                    # Unrestricted bash
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/*":*)   # Restricted to plugin scripts
  - Read(*:*)
  - Grep(*:*)
model: opus                                       # Specify for complex tasks
---

# Command Title

[Instructions for Claude on how to execute this command]
```

**Model options:**
- `opus` or `claude-opus-4-5` - Complex reasoning, multi-step workflows
- `sonnet` or `claude-sonnet-4-5` - Moderate complexity
- Default (no model specified) may use Haiku - only for simple commands

### Path Resolution

**Pattern 1: Environment variable (preferred)**
```markdown
Execute: `"${CLAUDE_PLUGIN_ROOT}/scripts/mycommand/mycommand" $ARGUMENTS`
```

**Pattern 2: Two-stage resolution (works in dev and marketplace)**
```markdown
**Plugin location:** !`realpath ~/.claude/plugins/marketplaces/*/my-plugin 2>/dev/null || echo "$PWD"`

Execute: `<plugin-location>/scripts/mycommand/mycommand $ARGUMENTS`
```

**Why dynamic resolution:** Hardcoded paths like `/home/user/...` break when others install your plugin. Always use `${CLAUDE_PLUGIN_ROOT}` or dynamic discovery.

### Command Hierarchy

```
commands/feature.md         → /feature
commands/feature/create.md  → /feature:create
commands/feature/delete.md  → /feature:delete
```
</command_patterns>

---

<script_patterns>
## Script Patterns

### Standard Script Header

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

### Color Coding

```bash
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${GREEN}✓ Success${NC}"
echo -e "${RED}✗ Error${NC}"
echo -e "${YELLOW}⚠ Warning${NC}"
```

### Error Handling

```bash
# Always: stderr, descriptive message, non-zero exit
echo "Error: Could not find issue #${issue_number}" >&2
echo "Run 'gh issue list' to see available issues" >&2
exit 1
```

### Atomic Writes (CRITICAL)

```bash
# WRONG - corrupts file if interrupted
jq '.status = "done"' file.json > file.json

# RIGHT - atomic operation
jq '.status = "done"' file.json > file.json.tmp
mv file.json.tmp file.json
```

**Why atomic:** If the script is interrupted mid-write, direct overwrites corrupt the file. Temp file + mv is atomic on POSIX systems.

### Subcommand Router

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
</script_patterns>

---

<state_management>
## State Management

### Repository-Scoped State

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

**Note:** Add your state directory to `.gitignore` - state is repository-scoped but typically not committed:
```bash
echo ".myplugin/" >> .gitignore
# or
echo ".claude/myplugin/" >> .gitignore
```

### Per-Item Files

```bash
# RIGHT - one file per item (concurrent-safe)
.myplugin/meta/item-1.json
.myplugin/meta/item-2.json

# WRONG - monolithic state file (race conditions)
.myplugin/state.json  # Everything in one file
```

**Why per-item:** Monolithic files have race conditions when multiple processes update simultaneously. Per-item files are naturally concurrent-safe.

### JSON State with jq

```bash
# Create
jq -n --arg name "$name" --arg status "active" \
  '{name: $name, status: $status, created: now}' > "$STATE_DIR/meta/$id.json"

# Read
status=$(jq -r '.status' "$STATE_DIR/meta/$id.json")

# Update (atomic)
jq '.status = "completed"' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
```

**Why jq:** String concatenation like `echo "{\"name\": \"$name\"}"` breaks on special characters. jq handles escaping correctly.
</state_management>

---

<hooks_patterns>
## Hook Patterns

> **Note:** This repository does not currently have production hook examples. Patterns below are based on Claude Code documentation. When implementing hooks, test thoroughly as behavior may vary.

### Hook Registration

**hooks/hooks.json:**
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{
          "type": "command",
          "command": "${CLAUDE_PLUGIN_ROOT}/hooks/guard.py",
          "timeout": 5
        }]
      }
    ]
  }
}
```

### Hook Events

| Event | When | Use Case |
|-------|------|----------|
| `PreToolUse` | Before tool runs | Block dangerous commands |
| `PostToolUse` | After tool runs | Log operations, trigger follow-ups |
| `UserPromptSubmit` | User submits prompt | Enforce workflow rules |

### Exit Codes

- **0** - Allow operation
- **2** - Block operation (stderr shown to user)

### Hook Bypass (IMPORTANT)

**Never expose bypass mechanisms to the model:**

```python
# WRONG - model learns this pattern!
if os.environ.get("BYPASS") == "1":
    sys.exit(0)
```

```bash
# RIGHT - bypass set in backend script, not visible to model
export GUARD_BYPASS=1
./dangerous-operation.sh
```

**Why:** Models learn bypass patterns from training/context. Keep hooks strict; only bypass in controlled backend scripts.
</hooks_patterns>

---

<critical_rules>
## Critical Rules

**These cause failures if violated:**

| Rule | Why |
|------|-----|
| Only `plugin.json` in `.claude-plugin/` | Plugin loader expects single manifest; extra files cause silent failures |
| Version sync: `marketplace.json` = `plugin.json` | Version mismatch breaks installation and updates |
| No hardcoded paths | Plugins must work on any machine; use `${CLAUDE_PLUGIN_ROOT}` or `git rev-parse` |
| Repository-scoped state | Global state causes cross-repo contamination |
| Atomic writes | Direct overwrites corrupt files on interruption |
| Scripts must be executable | `chmod +x` required; non-executable scripts fail silently |
</critical_rules>

---

<common_workflows>
## Common Workflows

### Creating a New Plugin

1. **Examine reference implementations**
   ```bash
   ls -la git-tools/
   cat git-tools/.claude-plugin/plugin.json
   cat git-tools/commands/issue.md
   ```

2. **Create minimal structure**
   ```bash
   mkdir -p my-plugin/.claude-plugin my-plugin/commands
   ```

3. **Write plugin.json** (copy from reference, modify)

4. **Write one command** (start simple, iterate)

5. **Test locally** - Commands work immediately in the repo

### Adding a Command to Existing Plugin

1. **Read existing commands** in the plugin
2. **Follow established patterns** (frontmatter, path resolution, delegation)
3. **Create command file** in `commands/`
4. **Create backend script** if needed in `scripts/`
5. **Make script executable**: `chmod +x scripts/*/script`

### Adding a Hook

1. **Examine orchestration hooks** for patterns
   ```bash
   cat orchestration/hooks/hooks.json
   ```
2. **Create hooks/hooks.json** with registration
3. **Implement hook script** (Python or Bash)
4. **Test with intentionally blocked operation**
</common_workflows>

---

<pitfalls>
## Common Pitfalls Checklist

Quick reference for mistakes that cause failures:

| Pitfall | Wrong | Right |
|---------|-------|-------|
| Hardcoded paths | `/home/user/...` | `${CLAUDE_PLUGIN_ROOT}` or `git rev-parse` |
| Global state | `$HOME/.myplugin` | `$REPO_ROOT/.myplugin` |
| Non-atomic writes | `jq ... > f.json` | `jq ... > f.tmp && mv f.tmp f.json` |
| Version desync | Different versions in marketplace.json/plugin.json | Must match exactly |
| Missing model | Complex task with default model | Add `model: opus` for complex work |
| Non-executable scripts | Forgot `chmod +x` | Always `chmod +x scripts/*` |

### JSON String Concatenation (Common Mistake)

```bash
# WRONG - breaks on quotes, special chars, unicode
echo "{\"name\": \"$name\"}" > file.json

# RIGHT - jq handles all escaping correctly
jq -n --arg name "$name" '{name: $name}' > file.json
```

### Non-Idempotent Operations

```bash
# WRONG - fails on retry
create_item() {
  echo "$name" > "$STATE_DIR/$name"
}

# RIGHT - safe to retry
create_item() {
  [[ -f "$STATE_DIR/$name" ]] && { echo "Already exists"; return 0; }
  echo "$name" > "$STATE_DIR/$name"
}
```

For detailed examples of each pitfall, see earlier sections or [docs/references/pitfalls.md](docs/references/pitfalls.md).
</pitfalls>

---

<deep_dive_references>
## Deep Dive References

For advanced topics and edge cases, consult these detailed guides:

| Topic | Reference |
|-------|-----------|
| Command frontmatter options | [docs/references/commands.md](docs/references/commands.md) |
| Script utilities & helpers | [docs/references/scripts.md](docs/references/scripts.md) |
| Hook events & implementation | [docs/references/hooks.md](docs/references/hooks.md) |
| State management patterns | [docs/references/state.md](docs/references/state.md) |
| Architectural patterns | [docs/references/patterns.md](docs/references/patterns.md) |
| Publishing to marketplace | [docs/references/distribution.md](docs/references/distribution.md) |
| Testing & debugging | [docs/references/testing.md](docs/references/testing.md) |
| Complete example plugin | [docs/examples/todo-plugin.md](docs/examples/todo-plugin.md) |
</deep_dive_references>
