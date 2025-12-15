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

## Concrete Example

```markdown
---
description: Reviews code changes for security vulnerabilities and best practices
subagent-type: general-purpose
model: sonnet
allowed-tools:
  - Read(*:*)
  - Grep(*:*)
  - Glob(*:*)
---

# Code Reviewer Agent

## Context
Receives a list of changed files and reviews them for issues.

## Responsibilities
1. Read each changed file
2. Identify security vulnerabilities (injection, XSS, etc.)
3. Check for adherence to project conventions
4. Report findings with file:line references

## Constraints
- Do NOT modify any files
- Do NOT run tests or builds
- Focus only on the changed files provided

## Return Format
Markdown report with:
- Summary (pass/fail with issue count)
- Issues table (severity, file, line, description)
- Recommendations
```

## Reference Implementation

See `orchestration/agents/architect.md` for a production example.
