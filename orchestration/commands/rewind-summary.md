---
description: Create concise summary for conversation rewind
argument-hint: <checkpoint-message>
---

The user is about to rewind the conversation to: "$ARGUMENTS"

Create a brief summary (5-10 lines max) of what was accomplished AFTER that point:

**Required sections:**
1. What was fixed/completed (1-2 lines)
2. Key changes (files, methods, bugs fixed)
3. Important findings or discoveries
4. Commit info (if any)
5. Test results (pass/fail counts)

**Format:**
- Use markdown
- Be concise and actionable
- End with: "I fixed <WHAT> and now I want you to tackle <I_WILL_SAY_WHATS_NEXT>"

**Skip:**
- Verbose explanations
- Step-by-step details
- Code snippets
- Full file paths (use relative paths only)
