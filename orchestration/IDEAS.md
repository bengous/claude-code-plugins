# Future Enhancement Ideas

## Skills for Lazy Context Loading in Specialized Sub-Agents

**Date:** 2025-01-18
**Status:** Deferred for future implementation

### Concept

Use Agent Skills (introduced October 2025) to provide domain expertise to specialized sub-agents via lazy loading, reducing context consumption while maintaining high-quality outputs.

### Use Cases

**✅ Domain expertise in exploration (Phase 2)**
- `authentication-patterns` - Auth system analysis
- `api-design-patterns` - REST/GraphQL conventions
- `database-patterns` - Schema, migrations, ORM
- `testing-patterns` - Test structure, mocking, coverage
- `frontend-patterns` - React/Vue/Angular conventions
- `backend-patterns` - Service layer, middleware, routing

**✅ Architecture guidance (Phase 4)**
- `minimal-change` - Refactoring, backward compatibility
- `clean-architecture` - SOLID, DDD, layered design
- `performance-focused` - Optimization, caching, indexing
- `microservices` - Service boundaries, communication patterns

**✅ Quality review criteria (Phase 7)**
- `bug-detection` - Common bug patterns, edge cases
- `simplicity-review` - DRY, KISS, readability
- `security-review` - OWASP, input validation, auth
- `performance-review` - N+1 queries, memory leaks

**✅ Lazy loading specialized knowledge**
- Agents start with minimal context (~2K tokens)
- Skills auto-load when relevant (~3-5K tokens each)
- Only load what's needed for specific task
- Net savings: 5-10K tokens per agent

**✅ Team knowledge sharing**
- Skills committed to git repository
- Team members get expertise automatically
- Version controlled, rollback-friendly
- Discoverable, reusable knowledge

### Benefits

1. **Context Efficiency**: Agents start lean, load expertise on-demand
2. **Composable Expertise**: Mix and match Skills (auth + API, database + caching)
3. **Easy Updates**: Update Skill once, all agents benefit
4. **Team Alignment**: Shared expertise in discoverable format

### Implementation Structure

```
orchestration/
├── commands/           # Orchestration workflow
├── skills/             # Domain expertise (NEW!)
│   ├── exploration/
│   │   ├── authentication-patterns/SKILL.md
│   │   ├── api-design-patterns/SKILL.md
│   │   └── database-patterns/SKILL.md
│   ├── architecture/
│   │   ├── minimal-change/SKILL.md
│   │   ├── clean-architecture/SKILL.md
│   │   └── performance-focused/SKILL.md
│   └── review/
│       ├── bug-detection/SKILL.md
│       ├── simplicity-review/SKILL.md
│       └── security-review/SKILL.md
├── agents/             # Agent templates (reference Skills)
├── scripts/            # Worktree management
└── hooks/              # Safety enforcement
```

### How It Works

**Example: Phase 2 Exploration Agent**

**Without Skills:**
```markdown
# agents/code-explorer.md
[15,000 tokens of patterns, examples, best practices for all domains...]
```

**With Skills:**
```markdown
# agents/code-explorer.md
Your task is to explore the codebase.

Available Skills (auto-load when relevant):
- authentication-patterns
- api-design-patterns
- database-patterns

[2,000 tokens of basic instructions]
```

**Result:**
- Agent finds `src/auth/` → `authentication-patterns` Skill loads (3K tokens)
- Agent doesn't explore API code → `api-design-patterns` stays unloaded
- **Net: 5K tokens instead of 15K tokens**

### Agent Integration Pattern

Update agent prompts to reference Skills:

```markdown
# agents/code-explorer.md

## Available Skills

You have access to domain-specific Skills that automatically load when you encounter relevant code:
- Authentication patterns
- API design conventions
- Database schema analysis

**You don't need to invoke these Skills** - they activate automatically based on context.

## Instructions

1. Explore codebase with Glob/Grep/Read
2. Skills provide specialized guidance as needed
3. Return findings summary
```

### Estimated Effort

- **Week 1**: Create 5-7 core Skills (authentication, API, database, clean-arch, bug-detection)
- **Week 2**: Integrate Skills with agent prompts (explorer, architect, reviewer)
- **Week 3**: Test and measure context savings, iterate on Skill content

### References

- Agent Skills Overview: https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview
- Skills in Claude Code: https://docs.claude.com/en/docs/claude-code/skills
- Research findings: See conversation 2025-01-18 about Skills architecture

### Why Deferred

This is a valuable enhancement for context efficiency and team knowledge sharing, but it doesn't solve the immediate problem of **context drift after compaction** in long-running orchestrations. That problem requires **persistent memory/state**, which Skills don't provide.

**Priority:** Implement after solving the core context drift problem with file-based memory.
