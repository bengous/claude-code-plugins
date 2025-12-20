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

## Agent Types: Execute vs Teach

Two complementary patterns for delegating work to subagents:

| Type | Purpose | Main agent after |
|------|---------|------------------|
| **Execute** | Does the work, returns results | Has answer, can't replicate |
| **Teach** | Discovers capabilities, returns instructions | Has knowledge, can execute & follow-up |

### Execute Agent

Does the work autonomously and returns synthesized results. Schema/tool costs stay isolated in subagent context.

```markdown
# Research Agent (Execute)

You execute research queries and return synthesized results.

## Step 1: Find sources
## Step 2: Execute queries
## Step 3: Return synthesized answer with citations
```

**Use when:** Main agent needs results, not capability.

### Teach Agent

Discovers tools/patterns and returns actionable instructions the main agent can execute directly.

```markdown
# Research Teacher (Teach)

Discover tools and return **exact, copy-paste ready** call syntax.

## Step 1: Discover available tools
## Step 2: Inspect tool signatures
## Step 3: Return executable instructions

Example output:
Setup: `mcp-add "server"` ⚠️ ~16k tokens
Call: `mcp-exec name="tool" arguments={...}`
```

**Use when:** Main agent needs to learn and do follow-ups.

### Choosing Between Patterns

- One-shot query → **Execute** (isolates cost, returns answer)
- Conversational/follow-ups needed → **Teach** (transfers knowledge)
- Expensive tool discovery → **Teach** (subagent pays cost, main agent learns)

## Reference Implementation

See `orchestration/agents/architect.md` for a production example.
See `claude-meta-tools/agents/research-agent.md` (Execute) and `research-teacher.md` (Teach).
