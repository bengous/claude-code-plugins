---
description: Turn discussions into executable, self-contained implementation plans
argument-hint: [feature description]
---

# Mega-Plan

Load and follow the mega-plan skill: `${CLAUDE_PLUGIN_ROOT}/skills/mega-plan/SKILL.md`

**Entry detection:**
- If user provided `$ARGUMENTS` → fresh start, begin at Step 1
- If invoked without arguments mid-conversation → synthesize prior discussion, then Step 1
