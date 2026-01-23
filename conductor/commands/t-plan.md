---
description: Thorough planning using 6-step orchestrator-subagent workflow
argument-hint: [feature description]
---

# T-Plan (Thorough Plan)

Invoke the t-plan skill:

```
Skill(skill: "t-plan")
```

**Entry detection:**
- If user provided `$ARGUMENTS` → fresh start, begin at INTENT step
- If invoked without arguments mid-conversation → synthesize prior discussion, then INTENT step
