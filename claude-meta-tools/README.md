# Claude Meta-Tools Plugin

Meta-tools for Claude Code: maintain project memory (CLAUDE.md), create and manage skills, and extend Claude's capabilities.

## Overview

This plugin provides essential tools for working with Claude Code itself - maintaining documentation, creating skills, and extending capabilities. Whether you're syncing project documentation or building custom skills, these tools help you customize and enhance your Claude Code experience.

## Commands

### Documentation Maintenance

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

---

### Skill Creation & Management

#### `/skill-creator`

Interactive guide for creating effective skills that extend Claude's capabilities.

**Usage:**
```bash
/skill-creator
```

Provides comprehensive guidance on:
- Skill design principles
- Structure and anatomy
- Best practices and patterns
- Tool restrictions and permissions

#### `/skill-creator:init <name> [--path <dir>]`

Initialize a new skill with proper structure and boilerplate.

**Usage:**
```bash
# Create skill in default location (~/.claude/skills/)
/skill-creator:init my-skill

# Create skill in specific directory
/skill-creator:init my-skill --path ./.claude/skills

# Create skill in plugin
/skill-creator:init my-plugin-skill --path ./my-plugin/skills
```

**What it creates:**
- `SKILL.md` with proper frontmatter
- Skill directory structure
- Basic documentation template

#### `/skill-creator:validate <path>`

Validate skill structure and configuration.

**Usage:**
```bash
/skill-creator:validate ~/.claude/skills/my-skill
/skill-creator:validate ./.claude/skills/team-skill
/skill-creator:validate ./my-plugin/skills/plugin-skill
```

**Checks:**
- SKILL.md exists and has valid frontmatter
- Required fields present (name, description)
- Directory structure is correct
- File paths and references are valid

#### `/skill-creator:package <path> [--output <dir>]`

Package a skill for distribution (useful for sharing or plugin bundling).

**Usage:**
```bash
# Package skill to default output
/skill-creator:package ~/.claude/skills/my-skill

# Package to specific location
/skill-creator:package ~/.claude/skills/my-skill --output ./dist
```

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

### Scenario 2: Create Personal Skill

```
User: /skill-creator:init pdf-analyzer --path ~/.claude/skills

Created skill structure:
  ~/.claude/skills/pdf-analyzer/
  └── SKILL.md

User: [edits SKILL.md with PDF analysis workflow]

User: /skill-creator:validate ~/.claude/skills/pdf-analyzer

✓ Valid SKILL.md structure
✓ Required frontmatter fields present
✓ Description is clear and specific
```

### Scenario 3: Create Team Skill

```
User: /skill-creator:init api-integration --path ./.claude/skills

Created skill structure:
  ./.claude/skills/api-integration/
  └── SKILL.md

[Team member commits skill to repo]
[Other team members pull and skill is automatically available]
```

### Scenario 4: Build Plugin Skill

```
User: /skill-creator:init code-formatter --path ./my-plugin/skills

Created skill structure:
  ./my-plugin/skills/code-formatter/
  └── SKILL.md

User: /skill-creator:validate ./my-plugin/skills/code-formatter

✓ Valid plugin skill structure

User: /skill-creator:package ./my-plugin/skills/code-formatter

✓ Skill packaged successfully
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

### Skill Creation Workflow

```
Phase 1: Initialize
└─ /skill-creator:init <name> creates structure

Phase 2: Design
├─ Define skill purpose and triggers
├─ Write workflow instructions
└─ Add examples and references

Phase 3: Validate
└─ /skill-creator:validate checks structure

Phase 4: Test
└─ Use skill in real scenarios

Phase 5: Distribute (optional)
├─ Personal: Keep in ~/.claude/skills/
├─ Team: Commit to ./.claude/skills/
└─ Plugin: Package with /skill-creator:package
```

## Skills Included

### sync-claude-md
Comprehensive workflow for maintaining CLAUDE.md files with git analysis and parallel agent review.

### skill-creator
Guide for creating effective skills with design principles, best practices, and examples.

## Best Practices

### Documentation (CLAUDE.md)
- Technical guidance over vague descriptions
- Commands with clear descriptions
- Code style guidelines and conventions
- Architecture patterns documentation
- Testing instructions
- Repository etiquette
- Security policies

### Skill Creation
- Concise context (context window is shared)
- Specific descriptions with activation triggers
- Appropriate degrees of freedom (text vs scripts)
- Tool restrictions via `allowed-tools`
- Clear examples over verbose explanations
- Focus on one capability per skill

## Configuration

No configuration needed. All tools:
- Detect project structure automatically
- Fetch official documentation dynamically
- Adapt to context automatically
- Manage resources efficiently

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
