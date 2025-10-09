# Safety Hooks

Documentation for the automatic safety hook system.

## Overview

The Claude Orchestration plugin includes three safety hooks that automatically enforce workflow rules and prevent common mistakes. These hooks run transparently in the background, intercepting potentially problematic operations before they execute.

## Hook Architecture

Hooks are registered in `plugin.json` and triggered by Claude Code at specific lifecycle points:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{"type": "command", "command": "hooks/worktree-guard.py"}]
      },
      {
        "matcher": "SlashCommand",
        "hooks": [{"type": "command", "command": "hooks/pr-guard.sh"}]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [{"type": "command", "command": "hooks/planmode.sh"}]
      }
    ]
  }
}
```

### Hook Types

1. **PreToolUse** - Runs before a tool is executed
   - `matcher: "Bash"` - Intercepts bash commands
   - `matcher: "SlashCommand"` - Intercepts slash commands

2. **UserPromptSubmit** - Runs when user submits a prompt
   - No matcher needed (runs on all prompts)

### Hook Execution Flow

```
User Action
    │
    ├─► Claude Code intercepts
    │
    ├─► Triggers matching hooks
    │   │
    │   ├─► Hook reads context (stdin JSON)
    │   ├─► Hook validates operation
    │   └─► Hook returns exit code:
    │       • exit 0 → Allow operation
    │       • exit 1 → Block with error
    │       • exit 2 → Block with guidance
    │
    └─► If allowed, proceed with operation
```

## The Three Safety Hooks

### 1. worktree-guard.py

**Purpose:** Prevents direct use of `git worktree` and `git branch -D` commands to maintain metadata consistency.

**Trigger:** `PreToolUse` → `Bash`

**Location:** `orchestration/hooks/worktree-guard.py`

#### What It Blocks

```python
BLOCKED = {
    ("git", "worktree", "add"),
    ("git", "worktree", "remove"),
    ("git", "worktree", "prune"),
    ("git", "worktree", "move"),
    ("git", "worktree", "repair"),
    ("git", "branch", "-D"),
}
```

#### Example Blocked Operation

**User/Agent attempts:**
```bash
git worktree add ../new-feature
```

**Hook intercepts and blocks:**
```
🚫 Blocked raw git worktree command: git worktree add ../new-feature

This bypasses worktree management. Use the CLI instead:
  • /worktree:create <name>      create worktree safely
  • /worktree:delete <name>      remove worktree safely
  • /worktree:prune --force      clean up multiple worktrees
```

#### Why This Matters

Raw git commands bypass:
- Metadata tracking (`.claude/worktrees/*.json`)
- Lock system (concurrency control)
- State consistency
- Audit trails

Without metadata, the orchestration system can't:
- Track lock ownership
- Show worktree status
- Transfer ownership
- Clean up properly

#### Allowed Commands

The hook only blocks worktree management. These are allowed:
```bash
git status              ✓
git commit              ✓
git push                ✓
git log                 ✓
git diff                ✓
git checkout <branch>   ✓
git branch (list)       ✓
```

#### Manual Override

**Note:** The hook intentionally provides NO escape hatch. If you need raw git commands:

1. **Exit Claude Code session**
2. **Run commands in regular shell**
3. **Update metadata manually if needed:**
   ```bash
   # Example: manually created worktree
   git worktree add ../my-worktree

   # Add metadata
   echo '{
     "name": "my-worktree",
     "branch": "my-branch",
     "path": "../my-worktree",
     "created_at": "2025-10-09T14:30:52Z"
   }' > .claude/worktrees/my-worktree.json
   ```

#### Implementation Details

```python
#!/usr/bin/env python3
import json
import sys

# Read tool invocation from stdin
payload = json.load(sys.stdin)
argv = payload.get("command") or []

# Check if command matches blocked pattern
for block in BLOCKED:
    if match(block):
        sys.stdout.write(GUIDE.format(cmd=cmd))
        sys.exit(2)  # Exit code 2 = block with guidance

sys.exit(0)  # Exit code 0 = allow
```

---

### 2. pr-guard.sh

**Purpose:** Enforces COMPLEX mode PR targeting rules to prevent premature PRs to main branch.

**Trigger:** `PreToolUse` → `SlashCommand`

**Location:** `orchestration/hooks/pr-guard.sh`

#### What It Enforces

In COMPLEX mode orchestration:
- **Sub-PRs** must target the **base branch** (NOT `dev`)
- Only the **final PR** from **base branch** can target `dev`
- Only when on the base branch itself

#### Example: Correct COMPLEX Flow

```bash
# Create base branch
git checkout -b feat/auth-system origin/dev

# Step 1: Create sub-PR
git checkout -b feat/auth-system-core feat/auth-system
/pr:create --head feat/auth-system-core --base feat/auth-system
✓ Allowed (sub-PR to base branch)

# Step 2: Another sub-PR
git checkout -b feat/auth-system-oauth feat/auth-system
/pr:create --head feat/auth-system-oauth --base feat/auth-system
✓ Allowed (sub-PR to base branch)

# After all sub-PRs merged, final PR
git checkout feat/auth-system
/pr:create --base dev
✓ Allowed (from base branch to dev)
```

#### Example: Blocked Operation

**Scenario:** In COMPLEX mode with base branch `feat/auth-system`

**User/Agent attempts:**
```bash
git checkout feat/auth-system-core
/pr:create --base dev  # ← Trying to PR directly to dev
```

**Hook intercepts and blocks:**
```
🚫 BLOCKED: Invalid PR target for COMPLEX orchestration

You are in COMPLEX mode with base branch: feat/auth-system
Current branch: feat/auth-system-core

COMPLEX mode policy:
  - Sub-PRs must target the base branch (feat/auth-system), not dev
  - Only the final PR from base branch to dev is allowed
  - Current command would create PR from feat/auth-system-core to dev

Correct approach:
  1. Create sub-PRs: /pr:create --head feat/auth-system-core --base feat/auth-system
  2. After all sub-PRs merged, create final PR: /pr:create --head feat/auth-system --base dev

If you believe this is the final PR:
  1. Ensure you're on the base branch: git checkout feat/auth-system
  2. Then run: /pr:create --base dev
```

#### How It Detects COMPLEX Mode

The hook checks for orchestration state:

```bash
# Read state file
state_file=".claude/run/current.json"
orch_type=$(jq -r '.type' "${state_file}")

# Only enforce in COMPLEX mode
if [[ "${orch_type}" != "COMPLEX" ]]; then
    exit 0  # Allow
fi
```

#### State File Structure

```json
// .claude/run/current.json
{
  "type": "COMPLEX",
  "base": "feat/auth-system",
  "status": "executing"
}
```

#### When Hook Allows

The hook allows PRs when:
1. Not in COMPLEX mode (SIMPLE/MEDIUM)
2. No orchestration state exists
3. PR targets base branch (sub-PR)
4. On base branch AND targeting dev (final PR)

#### Implementation Details

```bash
#!/bin/bash
set -euo pipefail

# Read hook input
input=$(cat)

# Extract command
command=$(echo "${input}" | jq -r '.tool_input.command')

# Only check /pr:create commands
if [[ ! "${command}" =~ ^/pr:create ]]; then
    exit 0
fi

# Check orchestration state
if [[ -f ".claude/run/current.json" ]]; then
    orch_type=$(jq -r '.type' ".claude/run/current.json")

    if [[ "${orch_type}" == "COMPLEX" ]]; then
        # Validate PR target
        # ... validation logic ...
    fi
fi

exit 0
```

---

### 3. planmode.sh

**Purpose:** Ensures `/orc:start` uses planning phase for thoughtful task classification.

**Trigger:** `UserPromptSubmit`

**Location:** `orchestration/hooks/planmode.sh`

#### What It Enforces

When `/orc:start` is invoked:
1. Must go through PHASE 1 (classification)
2. Must present plan with rationale
3. Cannot skip directly to execution

#### Example: First Invocation

**User submits:**
```bash
/orc:start "Implement user authentication"
```

**Hook detects first invocation:**
```
📋 Plan Mode Enforced for /orc:start

The /orc:start command requires a planning phase first.

You must:
1. Analyze the task
2. Classify as SIMPLE/MEDIUM/COMPLEX
3. Present your plan and rationale
4. Wait for user approval before execution

Please proceed with PHASE 1: Task Classification.
```

**Claude proceeds with classification:**
```
Task Classification: COMPLEX

Path chosen: COMPLEX
Rationale:
  • Multi-module changes (auth, user, API)
  • Cross-cutting authentication concern
  • High risk of breaking functionality

Execution approach:
  1. Create base branch: feat/auth-system
  2. Decompose into 3 steps
  3. Sub-PR for each step
  4. Final PR to dev

[Proceeding to PHASE 2...]
```

#### Approval Marker

For subsequent invocations or approved plans:

```bash
# After plan approval
touch .claude/run/orc-plan-approved

# Hook sees marker and allows execution
```

The marker is automatically cleaned up after use.

#### When Hook Allows

The hook allows execution when:
1. Plan approval marker exists
2. Prompt contains plan-related keywords:
   - "PHASE 1"
   - "Task Classification"
   - "Path chosen"
3. Not the initial `/orc:start` invocation

#### Why This Matters

Without planning phase:
- Tasks might be misclassified
- Complex tasks could use wrong path
- No rationale for approach
- Higher risk of mistakes

With planning phase:
- Thoughtful analysis
- Appropriate path selection
- Clear execution strategy
- User can review and approve

#### Implementation Details

```bash
#!/bin/bash
set -euo pipefail

# Read user prompt
input=$(cat)
prompt=$(echo "${input}" | jq -r '.prompt')

# Check if /orc:start
if [[ ! "${prompt}" =~ ^/orc:start ]]; then
    exit 0  # Not /orc:start, allow
fi

# Check for approval marker
marker_file=".claude/run/orc-plan-approved"
if [[ -f "${marker_file}" ]]; then
    rm -f "${marker_file}"  # Clean up
    exit 0  # Approved, allow
fi

# Check if this is a plan response
if [[ "${prompt}" =~ "PHASE 1" ]] || [[ "${prompt}" =~ "Path chosen" ]]; then
    exit 0  # Planning in progress, allow
fi

# First invocation, enforce planning
cat >&2 <<EOF
📋 Plan Mode Enforced for /orc:start
...
EOF

exit 0  # Still allow (command contains plan logic)
```

---

## Hook Interaction Diagram

```
User: /orc:start "Build auth system" --issue 42
    │
    ├─► planmode.sh (UserPromptSubmit)
    │   └─► Enforces planning phase
    │       └─► Allows (first time, needs classification)
    │
    ├─► Claude classifies task
    │   └─► Presents plan
    │   └─► User approves
    │
    ├─► Claude proceeds to execution
    │   └─► Creates base branch: feat/auth-system
    │
    ├─► Claude creates step branch
    │   └─► git checkout -b feat/auth-system-core feat/auth-system
    │
    ├─► Claude creates sub-PR
    │   └─► /pr:create --head feat/auth-system-core --base feat/auth-system
    │       │
    │       └─► pr-guard.sh (PreToolUse → SlashCommand)
    │           └─► Checks: PR to base branch?
    │           └─► Allows (correct target)
    │
    ├─► Claude attempts final PR (wrong time)
    │   └─► /pr:create --head feat/auth-system-core --base dev
    │       │
    │       └─► pr-guard.sh (PreToolUse → SlashCommand)
    │           └─► Checks: PR from step to dev?
    │           └─► BLOCKS (must PR to base, not dev)
    │
    └─► Claude corrects and creates proper final PR
        └─► git checkout feat/auth-system
        └─► /pr:create --base dev
            │
            └─► pr-guard.sh
                └─► Checks: On base branch, PR to dev?
                └─► Allows (correct final PR)
```

## Debugging Hooks

### Enable Hook Debugging

Hooks output to stderr, visible in Claude Code:

```bash
# Hooks already output to stderr
# Claude Code displays hook messages
```

### Check Hook Execution

```bash
# View hook files
ls -la orchestration/hooks/

# Check permissions
chmod +x orchestration/hooks/*.sh orchestration/hooks/*.py

# Test hook manually
echo '{"command": ["git", "worktree", "add", "../test"]}' | \
  orchestration/hooks/worktree-guard.py
```

### Hook Exit Codes

- `exit 0` - Allow operation
- `exit 1` - Block with generic error
- `exit 2` - Block with guidance message

### Common Issues

**Hook not triggering:**
```bash
# Check plugin.json registration
cat orchestration/plugin.json | jq '.hooks'

# Ensure hook is executable
chmod +x orchestration/hooks/*.sh orchestration/hooks/*.py

# Reload plugin
/plugin reload
```

**Hook blocking valid operation:**
```bash
# Check state files
cat .claude/run/current.json

# Clear state if corrupted
rm .claude/run/current.json

# Remove approval marker if stuck
rm .claude/run/orc-plan-approved
```

## Hook Best Practices

1. **Don't Fight the Hooks**
   - Hooks enforce best practices
   - Follow the guidance messages
   - Use recommended commands

2. **Understand the Intent**
   - worktree-guard: Metadata consistency
   - pr-guard: Incremental review
   - planmode: Thoughtful classification

3. **Work With the System**
   - Use `/worktree:*` commands
   - Follow COMPLEX mode structure
   - Trust classification process

4. **Debug When Needed**
   - Check state files
   - Verify hook permissions
   - Test hooks manually

## Extending Hooks

### Adding a New Hook

1. **Create hook script:**
   ```bash
   # orchestration/hooks/my-hook.sh
   #!/bin/bash
   set -euo pipefail

   input=$(cat)
   # ... validation logic ...

   exit 0  # Allow
   ```

2. **Make executable:**
   ```bash
   chmod +x orchestration/hooks/my-hook.sh
   ```

3. **Register in plugin.json:**
   ```json
   {
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "Bash",
           "hooks": [
             {
               "type": "command",
               "command": "${CLAUDE_PLUGIN_ROOT}/hooks/my-hook.sh",
               "timeout": 5
             }
           ]
         }
       ]
     }
   }
   ```

4. **Reload plugin:**
   ```bash
   /plugin reload
   ```

### Hook Input Format

Hooks receive JSON on stdin:

**PreToolUse hooks:**
```json
{
  "tool_name": "Bash",
  "tool_input": {
    "command": "git worktree add ../test"
  }
}
```

**UserPromptSubmit hooks:**
```json
{
  "prompt": "/orc:start \"Task description\""
}
```

### Hook Output

- **stdout:** Guidance message (shown to user)
- **stderr:** Debug info (logged)
- **exit code:** Decision (0=allow, 1/2=block)

---

## Summary

The three safety hooks provide:

1. **worktree-guard.py**
   - Maintains metadata consistency
   - Prevents raw git worktree commands
   - Ensures lock system integrity

2. **pr-guard.sh**
   - Enforces COMPLEX mode rules
   - Prevents premature PRs to dev
   - Enables incremental review

3. **planmode.sh**
   - Ensures thoughtful classification
   - Prevents skipping planning
   - Improves decision quality

Together, these hooks create a safe, consistent, and reliable orchestration environment.

---

**Next:** [Troubleshooting Guide](troubleshooting.md) for common issues and solutions.
