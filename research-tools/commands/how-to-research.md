---
description: Learn which MCP tools to use for researching a topic
argument-hint: "<topic>"
allowed-tools:
  - Agent
---

Call the Agent tool with `subagent_type: "research-tools:research-teacher"`.

Pass the topic exactly as provided: `$ARGUMENTS`

The agent will return tool instructions you can execute directly. After receiving the instructions, run the suggested tool calls yourself.
