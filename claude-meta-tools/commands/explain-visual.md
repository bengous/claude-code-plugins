---
description: Explain a concept with ASCII diagrams visible in the terminal
argument-hint: <topic>
allowed-tools:
  - Read
  - Glob
  - Grep
  - WebSearch
  - WebFetch
  - mcp__*
---

# Visual Explanation Request

**Topic:** $ARGUMENTS

## Your Task

Provide a clear, thorough explanation of the requested topic, accompanied by **ASCII diagrams** that visualize architecture, workflows, or relationships directly in the terminal.

## Instructions

### 1. Understand the Context

- Search the codebase for relevant implementations
- Check existing documentation and comments
- Look for related patterns or usages

### 2. Provide a Structured Explanation

- **What it is:** Define the concept/pattern/code
- **Why it exists:** Purpose and motivation
- **How it works:** Implementation details with code references
- **Where it's used:** Specific locations in the codebase (file:line)
- **Related concepts:** Connected patterns or dependencies

### 3. Create ASCII Visualizations

For each major aspect, create an appropriate ASCII diagram:

**Architecture diagrams:**
```
┌─────────────┐     ┌─────────────┐
│   Client    │────▶│   Server    │
└─────────────┘     └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  Database   │
                    └─────────────┘
```

**Flow diagrams:**
```
   ┌─────────┐
   │  Start  │
   └────┬────┘
        ▼
   ┌─────────┐    Yes   ┌─────────┐
   │ Valid?  │─────────▶│ Process │
   └────┬────┘          └─────────┘
        │ No
        ▼
   ┌─────────┐
   │  Error  │
   └─────────┘
```

**Sequence diagrams:**
```
Client              Server              Database
  │                    │                    │
  │───── request ─────▶│                    │
  │                    │──── query ────────▶│
  │                    │◀─── result ────────│
  │◀──── response ─────│                    │
  │                    │                    │
```

**Hierarchy/tree:**
```
src/
├── components/
│   ├── Button.tsx
│   └── Form.tsx
├── hooks/
│   └── useAuth.ts
└── utils/
    └── api.ts
```

**Data flow:**
```
┌────────┐    ┌────────┐    ┌────────┐
│ Input  │───▶│ Process│───▶│ Output │
└────────┘    └────────┘    └────────┘
     │                            │
     └────── feedback ────────────┘
```

### 4. Diagram Guidelines

- Use box-drawing characters: `─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼`
- Use arrows: `▶ ◀ ▲ ▼ ──▶ ◀──`
- Keep width under 80 characters for terminal compatibility
- Label all components clearly
- Use whitespace for readability

### 5. Include Code Examples

- Show actual code from the repository
- Demonstrate usage patterns
- Highlight key points with file references

## Output Format

```markdown
## Overview
[Brief summary]

## Architecture
[ASCII diagram showing structure]

## How It Works
[Explanation with code references]

## Flow
[ASCII diagram showing process/workflow]

## Code Examples
[Actual code with file:line references]

## Related Concepts
[Connections to other patterns]
```

## Success Criteria

- The concept is clearly defined
- At least one ASCII diagram visualizes the architecture/workflow
- Diagrams render correctly in terminal (monospace font)
- Code examples are shown with file locations
