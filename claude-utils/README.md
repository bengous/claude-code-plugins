# Claude Utils Plugin

Utility tools for Claude Code workflows: documentation maintenance, project automation, and development workflow helpers.

## Overview

This plugin provides utility commands and skills for common Claude Code workflows. Currently includes CLAUDE.md synchronization with plans to expand to other utility functions.

## Commands

### `/sync-claude-md`

Synchronize your project's CLAUDE.md file with codebase evolution by analyzing git history, spawning parallel review agents, and validating against official Anthropic best practices.

**Features:**
- **Git History Analysis**: Automatically detects what changed since last CLAUDE.md update
- **Smart Context Gathering**: Uses subagents for complex analysis when >10 commits
- **Parallel Agent Review**: Spawns 3 independent agents to review against official best practices
- **Official Documentation Validation**: Fetches latest Anthropic CLAUDE.md guidance
- **User Approval Gate**: Never auto-commits; always asks permission
- **Context Window Management**: Smart summarization to avoid token limits
- **New File Creation**: Generates comprehensive CLAUDE.md for new projects

**Usage:**
```bash
/sync-claude-md
```

**When to use:**
- CLAUDE.md hasn't been updated in many commits
- Major architectural changes occurred (new libraries, patterns, tools)
- CLAUDE.md doesn't exist and needs creation
- You want to validate CLAUDE.md against official best practices

## Workflow

### Update Existing CLAUDE.md

```
Phase 1: Discovery
├─ Locate CLAUDE.md (./CLAUDE.md or ./.claude/CLAUDE.md)
├─ Find last git update
└─ Count commits since update

Phase 2: Context Gathering
├─ If >10 commits: Use subagents for analysis
└─ If ≤10 commits: Direct commit analysis

Phase 3: Parallel Agent Review (3 agents)
├─ Each agent fetches official Anthropic docs
├─ Each reviews CLAUDE.md independently
└─ All report findings

Phase 4: Master Analysis
├─ Cross-reference 3 agent reports
├─ Validate against official docs
├─ Analyze gaps from git history
└─ Generate change proposal

Phase 5: User Approval
├─ Present detailed proposal
└─ Wait for approval (yes/no)

Phase 6: Application
├─ Apply changes if approved
└─ User commits manually
```

### Create New CLAUDE.md

If CLAUDE.md doesn't exist, the skill offers:
1. **Minimal Template**: Basic structure to fill in later
2. **Comprehensive Analysis**: Full project analysis with complete documentation

## Example Scenarios

### Scenario 1: Outdated after major refactor

```
User: /sync-claude-md

[15 commits since last update detected]
[Analyzes Effect.ts migration, Biome addition, architecture docs]
[3 agents review against official docs]

Proposed Changes:
- Add "Effect.ts Integration" section
- Update "Development Commands" (new lint commands)
- Add "Repository Etiquette" section
- Add "Security & Sensitive Data" section

Apply these changes? (yes/no)
```

### Scenario 2: Create new CLAUDE.md

```
User: /sync-claude-md

CLAUDE.md doesn't exist. Generate:
1. Minimal starter template
2. Comprehensive CLAUDE.md (full analysis)

Choose option (1 or 2): 2

[Analyzes project structure, dependencies, commands]
[Shows comprehensive CLAUDE.md preview]

Create this file? (yes/no)
```

## Best Practices Enforced

- Technical guidance over vague descriptions
- Commands with clear descriptions
- Code style guidelines and conventions
- Architecture patterns documentation
- Testing instructions
- Repository etiquette (branch naming, PR process)
- Security policies (never commit credentials)

## Configuration

No configuration needed. The skill:
- Detects project structure automatically
- Fetches official documentation dynamically
- Adapts to your git history depth
- Manages context window automatically

## Future Utilities

This plugin is designed to grow with additional utility commands:
- Project scaffolding helpers
- Common workflow automations
- Documentation generators
- Code quality checks

## License

Apache-2.0

## Author

Augustin BENGOLEA <bengous@protonmail.com>
