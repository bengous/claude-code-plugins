---
# No paths: field = always loaded (unconditional)
---

# Component Selection Guide

**Choose the right component for your task:**

| Need | Component | When to Use |
|------|-----------|-------------|
| User-triggered action | **Command** | User types `/something` to start a workflow |
| Safety/enforcement | **Hook** | Block dangerous operations, enforce workflow rules |
| Autonomous subtask | **Agent** | Delegated work that runs independently with its own context |
| Reusable knowledge | **Skill** | Instructions/patterns agents can invoke for specialized tasks |

## Decision Tree

```
Is this triggered by the user typing a slash command?
├── YES → Command
└── NO → Does it need to intercept/block operations?
    ├── YES → Hook
    └── NO → Is it autonomous work delegated to a subagent?
        ├── YES → Agent
        └── NO → Is it reusable knowledge/instructions?
            ├── YES → Skill
            └── NO → Probably a script (called by command)
```

## When to Use Each

**Commands** - Entry points for user interaction
- `/analyze-git` - User wants git analysis
- `/issue` - User wants to create an issue

**Hooks** - Enforcement and safety
- Block `git push --force` on main branch
- Require issue reference in commit messages

**Agents** - Delegated autonomous work
- `architect` agent designs implementation approach
- `implementation` agent writes code based on plan

**Skills** - Specialized knowledge injection
- `layer-testing` skill knows how to test architectural layers
- Agents invoke skills when they need domain expertise
