---
paths: "**/agents/**/*.md"
---

# Agent Patterns

Agents are **stateless subagents** that receive context once and return results. They run autonomously with their own context window.

## Agent Frontmatter

```markdown
---
description: Brief description of what this agent does
subagent-type: general-purpose
model: opus                    # or claude-opus-4-5, claude-sonnet-4-5
allowed-tools:
  - Read(*:*)
  - Grep(*:*)
  - Glob(*:*)
  - Bash(*:*)
---
```

**Model options:**
- `opus` or `claude-opus-4-5` - Complex reasoning, architecture, multi-step tasks
- `sonnet` or `claude-sonnet-4-5` - Simpler tasks, faster execution
- `haiku` - Quick, simple operations

## Agent Structure

```markdown
---
[frontmatter]
---

# Agent Name

## Context
[What this agent receives and its purpose]

## Responsibilities
1. First responsibility
2. Second responsibility

## Constraints
- What the agent must NOT do
- Boundaries to respect

## Return Format
[What the agent should output when done]
```

## Reference Implementation

See `orchestration/agents/architect.md` for a production example.
