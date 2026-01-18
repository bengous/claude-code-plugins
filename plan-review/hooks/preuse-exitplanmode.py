#!/usr/bin/env python3
"""
PreToolUse hook for ExitPlanMode.
Blocks plan execution until review status is APPROVED.
"""

import json
import sys
import re
from pathlib import Path

# Configuration
MAX_REVIEWS = 3
QUICK_BYPASS_MARKER = "<!-- QUICK -->"
MIN_LINES_FOR_REVIEW = 50


def find_plan_file(cwd: str) -> Path | None:
    """Find the plan file in .claude/plans/ directory."""
    claude_dir = Path(cwd) / ".claude" / "plans"
    if not claude_dir.exists():
        # Check home directory
        home_claude = Path.home() / ".claude" / "plans"
        if home_claude.exists():
            claude_dir = home_claude
        else:
            return None

    # Find the most recently modified .md file
    plan_files = list(claude_dir.glob("*.md"))
    if not plan_files:
        return None

    return max(plan_files, key=lambda p: p.stat().st_mtime)


def read_plan_content(plan_path: Path) -> str | None:
    """Read plan content from file."""
    try:
        return plan_path.read_text()
    except Exception:
        return None


def parse_review_status(plan: str) -> dict:
    """Parse the Plan Review Status section if present."""
    status = {
        "present": False,
        "approved": False,
        "review_count": 0,
        "status": "NONE"
    }

    match = re.search(
        r'## Plan Review Status\s*\n'
        r'Reviews:\s*(\d+)/\d+\s*\n'
        r'Status:\s*(\w+)',
        plan,
        re.MULTILINE
    )

    if match:
        status["present"] = True
        status["review_count"] = int(match.group(1))
        status["status"] = match.group(2).upper()
        status["approved"] = status["status"] == "APPROVED"

    return status


def should_bypass(plan: str) -> tuple[bool, str]:
    """Check if plan should bypass review."""
    # Quick bypass marker
    if QUICK_BYPASS_MARKER in plan:
        return True, "Quick bypass marker found"

    # Small plan threshold
    line_count = len(plan.strip().split('\n'))
    if line_count < MIN_LINES_FOR_REVIEW:
        return True, f"Plan is {line_count} lines (threshold: {MIN_LINES_FOR_REVIEW})"

    return False, ""


def main():
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        # Allow on parse failure (fail open for safety)
        sys.exit(0)

    tool_name = input_data.get("tool_name", "")
    cwd = input_data.get("cwd", ".")

    # Only handle ExitPlanMode
    if tool_name != "ExitPlanMode":
        sys.exit(0)

    # Find and read the plan file
    plan_path = find_plan_file(cwd)
    if not plan_path:
        # No plan file found - allow through
        sys.exit(0)

    plan = read_plan_content(plan_path)
    if not plan:
        # Could not read plan - allow through
        sys.exit(0)

    # Check bypass conditions
    bypass, reason = should_bypass(plan)
    if bypass:
        sys.exit(0)

    # Parse review status
    status = parse_review_status(plan)

    # If approved, allow through
    if status["approved"]:
        sys.exit(0)

    # If max reviews reached, allow with warning
    if status["review_count"] >= MAX_REVIEWS:
        print(json.dumps({
            "systemMessage": f"Warning: Plan approved after {MAX_REVIEWS} review cycles without full consensus."
        }))
        sys.exit(0)

    # Block and provide instructions
    review_count = status["review_count"]

    instructions = f"""
BLOCKED: Plan requires review before execution.

Plan file: {plan_path}
Review cycle: {review_count + 1}/{MAX_REVIEWS}

## Multi-Agent Review Process (3 rounds)

### Round 1: Independent Review (parallel)
Spawn TWO review agents IN PARALLEL using the Task tool.
**IMPORTANT**: Save the agent IDs returned - you'll need them for Round 2.

1. **Architect Reviewer** (subagent_type: "plan-review:architect-reviewer"):
   - Include the full plan content
   - Agent will challenge architectural decisions, verify best practices via MCP/web
   - Returns findings as HIGH/MEDIUM/LOW with verdict
   - **Save the agentId from the response**

2. **Code Simplifier** (subagent_type: "code-simplifier:code-simplifier"):
   - Include the full plan content
   - Ask it to review for over-engineering, unnecessary complexity, simpler alternatives
   - Returns findings with simplification recommendations
   - **Save the agentId from the response**

### Round 2: Cross-Review Debate (parallel)
After Round 1, RESUME both agents IN PARALLEL using the `resume` parameter with their agent IDs from Round 1.

Each agent receives (via prompt):
- The OTHER agent's Round 1 findings

Prompt each resumed agent to:
- Review the other's findings
- AGREE, DISAGREE, or ADD NUANCE to each point
- Identify any findings they now reconsider based on the other perspective
- State their final position on each issue

Example Task call for Round 2:
```
Task(resume="<architect-agent-id>", prompt="Here are the Code Simplifier's findings: ...")
Task(resume="<simplifier-agent-id>", prompt="Here are the Architect's findings: ...")
```

### Round 3: Consensus Formation (you synthesize)
After Round 2, YOU form the consensus:
1. **Aligned findings**: Issues both agents agree on → must address
2. **Disputed findings**: Where they disagree → use your judgment, document reasoning
3. **Withdrawn findings**: Issues an agent reconsidered → can skip

Update the plan:
1. Address all aligned HIGH severity concerns
2. Make judgment calls on disputed items (document why)
3. Add the "## Plan Review Status" section:

```markdown
## Plan Review Status
Reviews: {review_count + 1}/3
Status: APPROVED
Last Review: <current timestamp>

### Consensus Summary
**Aligned (addressed):**
- [finding]: [how addressed]

**Disputed (judgment call):**
- [finding]: [decision and reasoning]

**Withdrawn:**
- [finding]: [why reconsidered]
```

Then call ExitPlanMode again.

**Bypass options:**
- Add `{QUICK_BYPASS_MARKER}` to plan for trivial changes
- Plans under {MIN_LINES_FOR_REVIEW} lines auto-bypass
"""

    print(instructions, file=sys.stderr)
    sys.exit(2)


if __name__ == "__main__":
    main()
