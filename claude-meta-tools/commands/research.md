---
description: Research documentation using optimal MCP sources
argument-hint: "[query]"
allowed-tools:
  - Task
---

Call the Task tool with `subagent_type: "claude-meta-tools:research-agent"`.

Pass the query exactly as provided: `$ARGUMENTS`

The agent has complete instructions for finding documentation. If no query provided, infer what to research from conversation context.

Present the agent's synthesized results when done.
