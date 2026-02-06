# Claude Code Plugin Marketplace

This repository is a **plugin marketplace** for Claude Code.

## Reference Implementations

| Plugin | Complexity | Learn From |
|--------|------------|------------|
| `git-tools/` | Medium | Commands, scripts, state management, GitHub integration |
| `orchestration/` | Advanced | Agents, skills, hooks, multi-agent coordination |

## Plugin Structure

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json        # ONLY file allowed here
├── commands/              # Slash commands (required)
├── scripts/               # Backend implementation
├── hooks/                 # Optional: safety/enforcement
├── agents/                # Optional: subagent templates
└── skills/                # Optional: agent skills
```

## Critical Rules

| Rule | Why |
|------|-----|
| Only `plugin.json` in `.claude-plugin/` | Extra files cause silent discovery failures |
| Version sync: `plugin.json` = `marketplace.json` = `README.md` | Pre-commit hook validates all three match |
| No hardcoded paths | Use `${CLAUDE_PLUGIN_ROOT}` or `git rev-parse` |
| Repository-scoped state | Global state causes cross-repo contamination |
| Atomic writes | Direct overwrites corrupt files on interruption |
| Scripts must be executable | `chmod +x` required |

## Common Pitfalls

| Pitfall | Wrong | Right |
|---------|-------|-------|
| Hardcoded paths | `/home/user/...` | `${CLAUDE_PLUGIN_ROOT}` |
| Global state | `$HOME/.myplugin` | `$REPO_ROOT/.myplugin` |
| Non-atomic writes | `jq ... > f.json` | `jq ... > f.tmp && mv f.tmp f.json` |
| Version desync | Different versions | Must match exactly |
| JSON concatenation | `echo "{...}"` | `jq -n --arg ...` |

## Quick Start

1. Examine reference implementations: `ls git-tools/`
2. Create structure: `mkdir -p my-plugin/.claude-plugin my-plugin/commands`
3. Copy and modify `plugin.json` from reference
4. Write one command, test locally
5. Make scripts executable: `chmod +x scripts/*`
