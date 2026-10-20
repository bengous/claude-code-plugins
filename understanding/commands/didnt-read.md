---
description: Re-explain the last reply step by step, from zero. Alias of /recap steps.
disable-model-invocation: true
allowed-tools:
  - Read
  - Read(//**/understanding/shared/recap-body.md)
  - Grep
  - Glob
  - Bash(cat *)
---

Input: `steps`

!`cat ${CLAUDE_PLUGIN_ROOT}/shared/recap-body.md`
