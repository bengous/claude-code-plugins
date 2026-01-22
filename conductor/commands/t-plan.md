---
description: Thorough planning using 6-step orchestrator-subagent workflow
argument-hint: [feature description]
---

# T-Plan (Thorough Plan)

Load and follow the t-plan skill: `${CLAUDE_PLUGIN_ROOT}/skills/t-plan/SKILL.md`

**Entry detection:**
- If user provided `$ARGUMENTS` → fresh start, begin at INTENT step
- If invoked without arguments mid-conversation → synthesize prior discussion, then INTENT step
