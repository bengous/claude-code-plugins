---
paths: "**/hooks/**"
---

# Hook Patterns

Safety and workflow enforcement through the Claude Code hook system.

> **Note:** This repository does not currently have production hook examples. Patterns below are based on [Claude Code hooks documentation](https://code.claude.com/docs/en/hooks). When implementing hooks, test thoroughly as behavior may vary.

## Hook Registration

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

## Hook Events

| Event | When | Use Case |
|-------|------|----------|
| `PreToolUse` | Before tool runs | Block dangerous commands |
| `PostToolUse` | After tool runs | Log operations, trigger follow-ups |
| `UserPromptSubmit` | User submits prompt | Enforce workflow rules |

## Hook Implementation

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
            sys.stderr.write(f"Blocked dangerous command\n")
            sys.stderr.write(f"Use safe alternative instead\n")
            sys.exit(2)  # Exit 2 = block

sys.exit(0)  # Exit 0 = allow
```

## Hook Exit Codes

- **0**: Allow operation
- **2**: Block operation (stderr shown to user)
- **Other**: Error (stderr shown to user)

## Hook Bypass Pattern

**IMPORTANT:** Never expose bypass mechanisms to the model.

```bash
# In backend script (NOT in hook)
export GUARD_BYPASS=1
git push --force  # Hook checks GUARD_BYPASS and allows
```

**Why:** Models learn bypass patterns from training/context. Keep hooks strict. Only bypass in backend scripts that are not visible to the model.
