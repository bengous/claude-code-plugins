# Claude Meta-Tools Plugin

v3.2.0

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

### Prompt Tooling

#### `/prompt-health`

Health check for a prompt, command, skill, or agent doc. Two layers, no scores.

**Features:**
- **Harness staleness (deterministic)**: checks the artifact against Claude Code facts that
  changed — `ultrathink` as a budget dial, the spawn tool named `Task` rather than `Agent`,
  `budget_tokens`, assistant prefill, pinned prior-generation model IDs. Reproducible run to run.
- **Dated patterns (delegated)**: hands off to the native `/claude-api prompt-audit` for
  pressure language, replaced scaffolds, over-specification, and the proposed diff
- **Non-interactive and non-mutating**: states assumptions instead of asking, proposes edits
  without applying them

**Usage:**
```bash
/prompt-health path/to/SKILL.md
/prompt-health "inline prompt text" --model opus-5
```

**When to use:**
- Before committing a command, skill, or agent doc you have edited
- When a prompt was written for an earlier model generation and nobody has re-read it since

**Note:** replaces `/audit-prompt` (removed in v2.0.0 along with its qualitative scorecard).

### Context Files

#### `/context-audit`

Audit and improve CLAUDE.md, AGENTS.md and `.claude/rules/` files.

**Features:**
- **Instruction budget**: counts directives across the always-on surface (root + `@`-imports +
  always-on rules + global CLAUDE.md) against the ~100-directive comfortable band
- **Deterministic checks**: stale paths and commands verified against git and `package.json`,
  symlink and import resolution, linter overlap, architecture claims, undocumented env vars
- **Six anti-patterns**: linter overlap, generic advice, verbosity, non-universal scope,
  dead-end negatives, content decay
- **Financed additions**: `ADD` proposals must cite a concrete artefact and are budgeted
  against what the pruning frees — never offered when the projected budget stays over band
- **No grades**: a directive count is a measurement and is reported; a letter grade is not

**Usage:**
```bash
/context-audit                        # every context file in the repo
/context-audit path/to/CLAUDE.md      # one file
```

**When to use:**
- A CLAUDE.md has grown past the point where a new session reads it whole
- Before adding to a context file, to see whether the budget can afford it

## Use Cases

### Scenario 1: Maintain Project Documentation

```
User: /sync-claude-md

[15 commits since last update detected]
[Analyzes Effect.ts migration, Biome addition, architecture docs]

Proposed Changes:
- Add "Effect.ts Integration" section (Motivated by: a1b2c3d)
- Update "Development Commands" (new lint commands) (Motivated by: e4f5a6b)

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

Phase 3: Proposal & Approval
├─ Draft commit-motivated changes (Motivated by: <sha>)
├─ Present proposal, wait for approval (yes/no)
└─ Apply if approved; user commits manually
```

## Skills Included

### sync-claude-md

Maintains CLAUDE.md files by correlating git history since the file last changed with the claims it makes, then proposing commit-motivated updates. Invoke it directly with `/sync-claude-md`, or let Claude load it when you mention an outdated CLAUDE.md.

**Features:**
- **Git History Analysis**: Automatically detects what changed since last CLAUDE.md update
- **Smart Context Gathering**: Uses subagents for complex analysis when >10 commits
- **Commit-Motivated Proposals**: Every proposed change cites the commit(s) that motivate it
- **User Approval Gate**: Never auto-commits; always asks permission

**When to use:**
- CLAUDE.md hasn't been updated in many commits
- Major architectural changes occurred (new libraries, patterns, tools)

### context-audit
The repository's single auditor of context files. Discovers CLAUDE.md / AGENTS.md / `.claude/rules/` and their `@`-imports, measures the always-on instruction budget, runs deterministic staleness checks (paths, commands, linter overlap, architecture claims, undocumented env vars), detects six anti-patterns, then proposes REMOVE / MOVE / REWRITE / ADD / FLAG fixes and applies the approved ones. Additions are financed by what the pruning frees and must cite a concrete artefact. No grades, no aggregate score.

## Configuration

No configuration needed. All tools:
- Detect project structure automatically
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
