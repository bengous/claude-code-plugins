# Agent Context Audit

**Version 1.0.0**

Audit CLAUDE.md and AGENTS.md files against research-backed best practices. Scores instruction budget usage, detects anti-patterns, checks for staleness, and generates concrete fix proposals.

## Why

Agent context files are always-on prompt context that competes for a finite instruction budget. Research shows:
- Frontier models follow ~150-200 instructions with reasonable consistency
- Claude Code's system prompt consumes ~50 slots, leaving ~100-150 for user content
- Files that exceed this budget or contain anti-patterns cause uniform degradation of adherence to ALL instructions
- Context files can actually **reduce** task success rates when they impose unnecessary requirements

This plugin audits your files and tells you exactly what to change and why.

## Usage

```
/context-audit                        # Audit all context files in repo
/context-audit path/to/CLAUDE.md      # Audit a specific file
```

Or invoke naturally:
- "Audit my CLAUDE.md"
- "Check my instruction budget"
- "Is my AGENTS.md too bloated?"

## What It Checks

| Check | Type | What it detects |
|-------|------|-----------------|
| Instruction budget | Heuristic | Directive count vs ~100 recommended budget |
| Stale references | Deterministic | Broken file paths, missing commands |
| Linter overlap | Mixed | Style rules duplicating Biome/ESLint/Prettier config |
| Verbosity | Heuristic | Low directive density, verbose directives, embedded content |
| Progressive disclosure | Deterministic | Missing .claude/rules/, monorepo without subdirectory files |
| Negative w/o alternative | Heuristic | "Never use X" without saying what to use instead |
| Generic advice | Heuristic | Directives that fail the deletion test |

## Output

The audit produces a three-tier report:
1. **Executive Summary** — budget status, health checks, top 3 quick wins
2. **Full Proposals** — every finding with exact content, rationale, and confidence level
3. **Action Plan** — ordered list of changes to apply

Each proposal is one of: REMOVE, MOVE, REWRITE, or FLAG — always with concrete content, rationale, budget impact, and confidence level (HIGH for deterministic checks, MEDIUM for heuristic judgments).

## Relationship to Other Tools

| Tool | What it does | How it relates |
|------|-------------|----------------|
| `/init` (built-in) | Generate initial CLAUDE.md | Create first, then audit |
| `/sync-claude-md` | Add/update content from git history | Sync adds content, audit prunes it |
| `claude-md-improver` (Anthropic) | Quality scoring with rubric | Complementary — different methodology |

Intended workflow: `/init` → `/sync-claude-md` periodically → `/context-audit` to keep files lean.

## Author

Augustin BENGOLEA (bengous@protonmail.com)
