# Sync CLAUDE.md Plugin

Automatically synchronize your project's CLAUDE.md file with codebase evolution by analyzing git history, spawning parallel review agents, and validating against official Anthropic best practices.

## Overview

This plugin keeps project-level CLAUDE.md files up-to-date as your codebase evolves. It analyzes git commits since the last CLAUDE.md update, spawns 3 independent review agents to validate against official documentation, and proposes comprehensive updates with user approval.

## Features

- **Git History Analysis**: Automatically detects what changed since last CLAUDE.md update
- **Smart Context Gathering**: Uses subagents for complex analysis when >10 commits
- **Parallel Agent Review**: Spawns 3 independent agents to review against official best practices
- **Official Documentation Validation**: Fetches latest Anthropic CLAUDE.md guidance
- **User Approval Gate**: Never auto-commits; always asks permission
- **Context Window Management**: Smart summarization to avoid token limits
- **New File Creation**: Generates comprehensive CLAUDE.md for new projects

## When to Use

- CLAUDE.md hasn't been updated in many commits
- Major architectural changes occurred (new libraries, patterns, tools)
- CLAUDE.md doesn't exist and needs creation
- You want to validate CLAUDE.md against official best practices

## Usage

### Synchronize Existing CLAUDE.md

```bash
/sync-claude-md
```

The skill will:
1. Find when CLAUDE.md was last updated
2. Analyze commits since then
3. Spawn 3 parallel review agents
4. Fetch official Anthropic documentation
5. Generate comprehensive change proposal
6. Wait for your approval
7. Apply changes if approved

### Create New CLAUDE.md

If CLAUDE.md doesn't exist, the skill offers:
1. **Minimal Template**: Basic structure to fill in later
2. **Comprehensive Analysis**: Full project analysis with complete documentation

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

### Scenario 3: Minor updates needed

```
User: /sync-claude-md

[3 commits since last update]
CLAUDE.md is mostly up to date.

Proposed changes:
- Add command: 'bun run format'
- Update Important Notes with new library

Apply? (yes/no)
```

## Configuration

No configuration needed. The skill:
- Detects project structure automatically
- Fetches official documentation dynamically
- Adapts to your git history depth
- Manages context window automatically

## Best Practices Enforced

- Technical guidance over vague descriptions
- Commands with clear descriptions
- Code style guidelines and conventions
- Architecture patterns documentation
- Testing instructions
- Repository etiquette (branch naming, PR process)
- Security policies (never commit credentials)

## Error Handling

- **Missing git repo**: Warns and offers to create anyway
- **Duplicate CLAUDE.md files**: Warns and asks which to update
- **Unreachable docs**: Falls back to embedded best practices
- **Agent failures**: Continues with available agents or direct review

## Context Window Management

- Monitors token usage throughout
- Summarizes when >150k tokens used
- Uses subagents to offload heavy analysis
- Bailout warning at 180k tokens

## License

Apache-2.0

## Author

Augustin BENGOLEA <bengous@protonmail.com>
