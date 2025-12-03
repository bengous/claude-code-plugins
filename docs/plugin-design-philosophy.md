# Plugin Design Philosophy

> Lessons learned from building production Claude Code plugins.

---

## The Hybrid Model

The most effective plugin architecture separates decision-making from execution:

```
┌─────────────────────────────────────────────────────────┐
│  DECISION LAYER (Claude)                                │
│  - Analyzes repository context                          │
│  - Asks user when unclear (AskUserQuestion)             │
│  - Decides configuration and flags                      │
└─────────────────────┬───────────────────────────────────┘
                      │ passes explicit flags
                      ▼
┌─────────────────────────────────────────────────────────┐
│  EXECUTION LAYER (Scripts)                              │
│  - Flag-driven, no auto-detection                       │
│  - Reliable, deterministic                              │
│  - Atomic writes                                        │
└─────────────────────────────────────────────────────────┘
```

### Why This Works

| Approach | Problem |
|----------|---------|
| Script auto-detection | Brittle, can't handle edge cases, fails silently |
| Claude-only | Unreliable execution, inconsistent file operations |
| **Hybrid** | Claude handles ambiguity, scripts execute reliably |

### Example

```bash
# Bad: script guesses configuration
setup-workflow  # internally detects chezmoi vs stow vs project

# Good: Claude decides, script executes
setup-workflow \
  --source .claude/__settings.jsonc \
  --target .claude/settings.json \
  --hook-system lefthook
```

---

## Command Design Principles

### 1. Commands Are Prompts, Not Script Wrappers

A command file (`.md`) should guide Claude to:
1. **Explore** - Analyze the repository structure
2. **Decide** - Determine configuration (or ask user)
3. **Confirm** - Present plan, get approval
4. **Execute** - Call script with explicit flags
5. **Report** - Explain what was done and next steps

```markdown
---
description: Set up workflow in project
allowed-tools: Read, Glob, Bash, AskUserQuestion
model: opus
---

## Your Task

1. Explore the repo to understand its structure
2. Determine the appropriate configuration
3. If unclear, ask the user via AskUserQuestion
4. Execute: `${CLAUDE_PLUGIN_ROOT}/scripts/setup --flag1 X --flag2 Y`
```

### 2. Scripts Should Be Flag-Driven

Scripts should have **no auto-detection logic**. They receive explicit flags and execute accordingly:

```bash
# Script accepts all configuration as flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --hook-system) HOOK_SYSTEM="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) shift ;;
  esac
done

# Execute based on flags, no guessing
```

### 3. Complete the Workflow

Don't leave "next steps" for the user. If they chose a tool, finish the setup:

```bash
# Bad: create config, tell user to install
echo "Created lefthook.yml. Run: lefthook install"

# Good: create config AND install
echo "Created lefthook.yml"
if command -v lefthook &>/dev/null; then
  lefthook install
fi
```

### 4. Model Selection Matters

Specify model in frontmatter based on task complexity:

| Task Type | Model | Why |
|-----------|-------|-----|
| Complex setup wizard | `opus` | Nuanced decisions, handles edge cases |
| Simple execution | (default) | Straightforward tasks |
| Embedded error explanation | `haiku` | Fast, cheap, good enough |

```markdown
---
description: Complex setup requiring analysis
model: opus
---
```

---

## AI-Embedded Workflows

Claude can be embedded in hooks and scripts, not just interactive commands:

### Error Explanation in Hooks

```bash
# In a validation hook
if [[ $validation_failed == true ]]; then
  echo "Validation failed: $error_message"

  if [[ "${AI_EXPLAIN:-0}" == "1" ]] && command -v claude &>/dev/null; then
    echo "┌─ AI Analysis ─────────────────────────────────────┐"
    claude -p "Explain this error and suggest a fix:

Error: $error_message
File: $(cat $file)" --model haiku | sed 's/^/│ /'
    echo "└───────────────────────────────────────────────────┘"
  fi

  exit 1
fi
```

This transforms cryptic errors into actionable explanations without user intervention.

### When to Embed AI

| Scenario | Embed AI? | Why |
|----------|-----------|-----|
| Validation errors | Yes | Explain problems, suggest fixes |
| Success messages | No | Unnecessary cost |
| Ambiguous decisions | No | Use interactive AskUserQuestion |
| CI failures | Optional | Helpful but adds latency |

---

## When to Split vs Combine Commands

### Single Command When:
- One logical workflow (setup → analyze → execute)
- User shouldn't need to know intermediate steps
- Complex decisions require Claude's judgment

### Multiple Commands/Subcommands When:
- Distinct operations (sync, validate, check)
- CI/scripts call them directly without Claude
- Operations are independent and composable

### Pattern: Smart Command + Utility Script

```
/my-plugin:setup     → Claude analyzes, decides, calls script
my-script sync       → Direct execution for hooks/CI
my-script validate   → Direct execution for hooks/CI
my-script check      → Direct execution for hooks/CI
```

One smart command for humans, utility subcommands for automation.

---

## Handling Ambiguity

### Ask, Don't Guess

When context is unclear, use `AskUserQuestion`:

```markdown
**If the situation is ambiguous, ask the user:**
- "Is this a dotfiles repo or a regular project?"
- "I found both lefthook and husky - which do you prefer?"
- "Where should the settings files be created?"
```

### Provide Smart Defaults with Options

```
Detected: Node.js project with no hook system

Recommended: lefthook (lightweight, fast)

Options:
  1. lefthook (recommended)
  2. husky (npm ecosystem standard)
  3. Skip hooks (manual sync only)
```

---

## Summary

1. **Hybrid model**: Claude decides, scripts execute
2. **Flag-driven scripts**: No auto-detection, explicit configuration
3. **Complete workflows**: Don't leave "next steps"
4. **Model selection**: Opus for complexity, Haiku for embedded AI
5. **AI-embedded**: Error explanation in hooks
6. **Ask, don't guess**: Use AskUserQuestion for ambiguity
7. **Smart + utility**: One smart command, multiple utility subcommands
