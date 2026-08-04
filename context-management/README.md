# Context Management Plugin

v1.0.0

Lifecycle of Claude Code instruction files: audit the instruction budget of
CLAUDE.md / AGENTS.md / `.claude/rules/`, capture session learnings, and resync docs with
codebase evolution.

Extracted from claude-meta-tools 5.0.0.

## Commands

### `/context-audit`

Audit and improve CLAUDE.md, AGENTS.md and `.claude/rules/` files.

- **Instruction budget**: counts directives across the always-on surface (root + `@`-imports +
  always-on rules + global CLAUDE.md) against the ~100-directive comfortable band
- **Deterministic checks**: stale paths and commands verified against git and `package.json`,
  symlink and import resolution, linter overlap, architecture claims, undocumented env vars
- **Six anti-patterns**: linter overlap, generic advice, verbosity, non-universal scope,
  dead-end negatives, content decay
- **Financed additions**: `ADD` proposals must cite a concrete artefact and are budgeted
  against what the pruning frees
- **No grades**: a directive count is a measurement and is reported; a letter grade is not

```bash
/context-audit                        # every context file in the repo
/context-audit path/to/CLAUDE.md      # one file
```

### `/revise-claude-md`

Capture the current session's learnings (commands, gotchas, patterns) into CLAUDE.md or
`.claude/rules/`, with smart placement and a user approval gate. Distinct from
`/sync-claude-md`: this captures session learnings; that syncs against codebase/git evolution.

## Skills

### sync-claude-md

Maintains CLAUDE.md files by correlating git history since the file last changed with the
claims it makes, then proposing commit-motivated updates (`Motivated by: <sha>`). Never
auto-commits.

### context-audit

The audit methodology behind `/context-audit`: budget measurement, deterministic staleness
checks, anti-pattern detection, then approved REMOVE / MOVE / REWRITE / ADD / FLAG fixes.

## License

MIT

## Author

Augustin BENGOLEA <bengous@protonmail.com>
