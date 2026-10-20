---
description: Re-explain the last reply from zero, in layers, from the decision the user must take down to the steps. For when the user did not read a long reply.
argument-hint: "<nothing, a question, or one of: decisions | steps | diagram>"
disable-model-invocation: true
allowed-tools:
  - Read
  - Read(//**/understanding/shared/recap-body.md)
  - Grep
  - Glob
  - Bash(cat *)
---

Input: **$ARGUMENTS**

!`cat ${CLAUDE_PLUGIN_ROOT}/shared/recap-body.md`
