# Code Quality Plugin

Code quality and cleanup commands for maintaining clean, maintainable code.

## Commands

### `/code-quality:clean-pr-comments`

Review PR comments: fix bad naming, preserve necessary context.

### `/code-quality:lint-audit`

Audit a Biome/ESLint rule: research best practices, analyze violations, generate a fix
strategy.

### `/code-quality:clean-comments` — moved

Moved to the [clean-comments](../clean-comments/) plugin in 2.0.0, where it became a
skill with a four-action grid, a mechanical path probe, and a hunter agent for
repo-wide audits.

## Skills

### verify-no-regressions

Verify no behavioral regressions after implementation: spawns parallel subagents for
semantic diff review and test execution. Moved here from claude-meta-tools in 1.5.0.

## Philosophy

Good code should be self-documenting. Comments should only exist when:
1. The code does something non-obvious that can't be refactored to be clearer
2. There's important context (like why a magic number has that specific value)
3. You're defining a contract/interface that others will implement

Everything else is noise that becomes stale and misleading over time.

## Installation

This plugin is part of the `bengous-plugins` marketplace.

Add to `.claude/settings.json`:
```json
{
  "enabledPlugins": ["code-quality@bengous-plugins"]
}
```

Or install via command:
```bash
/plugin install code-quality@bengous-plugins
```

## License

MIT
