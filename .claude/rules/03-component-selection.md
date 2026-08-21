# Component Selection Guide

**Choose the right component for your task. Prefer simpler components when possible.**

| Need | Component | When to Use |
|------|-----------|-------------|
| User-triggered action | **Command** | User types `/something` to start a workflow |
| Safety/enforcement | **Hook** | Block dangerous operations, enforce workflow rules |
| Autonomous subtask | **Agent** | Delegated work that runs independently with its own context |
| Reusable knowledge | **Skill** | Instructions/patterns agents can invoke for specialized tasks |

If none of the four fits, it is probably a script called by a command.

## When to Use Each

**Commands** - Entry points for user interaction
- `/rebase` - User wants an interactive rebase
- `/issue` - User wants to create an issue

**Hooks** - Enforcement and safety
- Block `git push --force` on main branch
- Require issue reference in commit messages

**Agents** - Delegated autonomous work
- `architect` agent designs implementation approach
- `planning-coordinator` agent creates the execution plan and worktrees

**Skills** - Specialized knowledge injection
- `layer-testing` skill knows how to test architectural layers
- `git-sweep` skill knows how to categorize stale branches and worktrees
- Agents invoke skills when they need domain expertise
