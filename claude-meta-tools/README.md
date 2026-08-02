# Claude Meta-Tools Plugin

v1.14.0

Meta-tools for Claude Code: maintain project memory (CLAUDE.md), prompt coaching/auditing, research, and extend Claude's capabilities.

## Overview

This plugin provides essential tools for working with Claude Code itself - maintaining documentation, coaching prompts, researching topics, and extending capabilities.

## Commands

### Documentation Maintenance

#### `/demystify`

Explain a complex concept to a smart layperson with analogies, progressive depth, and honest simplification markers. Feynman/Sagan style.

**Features:**
- **Progressive Revelation**: One-sentence essence -> analogy -> real mechanism -> why it matters -> nuance
- **Smart Research**: Automatically decides whether to research or explain from knowledge
- **Mechanism-Mapping Analogies**: Maps how things work, not surface similarities
- **Honest Simplification**: Explicitly flags what the simplified version hid
- **Domain-Agnostic**: Works for CS, biology, physics, economics, philosophy -- any complex topic

**Usage:**
```bash
/demystify monads
/demystify how mRNA vaccines work
/demystify the CAP theorem
```

**When to use:**
- You want to understand a concept, not explore codebase implementation (use `/explain` for that)
- You're explaining something to a non-specialist audience
- You want analogies and progressive depth, not code references

#### `/sync-claude-md`

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

#### `/revise-claude-md`

Capture the current session's learnings (commands, gotchas, patterns) into CLAUDE.md or `.claude/rules/`.

**Features:**
- **Session Reflection**: Identifies context that was missing during the session
- **Smart Placement**: Routes additions to CLAUDE.md, `.claude/rules/<topic>.md`, or personal memory files
- **Concise Additions**: One line per concept; skips one-off fixes and obvious info
- **User Approval Gate**: Shows diffs, only edits approved files

**Usage:**
```bash
/revise-claude-md
```

**When to use:**
- End of a session where non-obvious commands or gotchas were discovered
- Distinct from `/sync-claude-md`: this captures session learnings; that syncs against codebase/git evolution

## Use Cases

### Scenario 1: Maintain Project Documentation

```
User: /sync-claude-md

[15 commits since last update detected]
[Analyzes Effect.ts migration, Biome addition, architecture docs]
[3 agents review against official docs]

Proposed Changes:
- Add "Effect.ts Integration" section
- Update "Development Commands" (new lint commands)
- Add "Repository Etiquette" section

Apply these changes? (yes/no)
```

## Workflow Examples

### Update CLAUDE.md Workflow

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

## Skills Included

### sync-claude-md
Comprehensive workflow for maintaining CLAUDE.md files with git analysis and parallel agent review.

### claude-md-improver
Audits and improves CLAUDE.md files across a repository: scans all memory files (CLAUDE.md, `.claude/rules/`, `@`-imports), evaluates quality against templates, reports, then applies approved targeted updates. For scored instruction-budget audits, defers to `agent-context-audit:context-audit`.

## Configuration

No configuration needed. All tools:
- Detect project structure automatically
- Adapt to context automatically
- Manage resources efficiently

`/sync-claude-md` additionally fetches official Anthropic documentation dynamically.

## Future Additions

This plugin can grow with:
- Config validators
- Project scaffolding
- Workflow templates
- Additional documentation tools
- Plugin development utilities

## License

Apache-2.0

## Author

Augustin BENGOLEA <bengous@protonmail.com>
