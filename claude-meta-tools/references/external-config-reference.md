# Claude Code External Configuration Reference

Claude Code's configuration system spans hooks, MCP servers, settings files, and CLI options distributed across user, project, and enterprise-managed locations. This document synthesizes all officially documented configuration options from Anthropic sources, marking gaps and uncertainties explicitly.

---

## Hooks system

**Source**: https://code.claude.com/docs/en/hooks, https://code.claude.com/docs/en/hooks-guide  
**Last Verified**: January 24, 2026  
**Confidence**: HIGH

Claude Code provides **10 hook events** that execute shell commands or LLM prompts at specific points in the workflow. Hooks can block operations, modify inputs, or inject context.

### Hook events reference

| Event | Description | Uses Matcher? |
|-------|-------------|---------------|
| `PreToolUse` | Runs before tool calls (can block/modify) | Yes |
| `PermissionRequest` | Runs when permission dialog shown (can allow/deny) | Yes |
| `PostToolUse` | Runs after tool calls complete successfully | Yes |
| `UserPromptSubmit` | Runs when user submits prompt, before processing | No |
| `Notification` | Runs when Claude Code sends notifications | Yes (notification type) |
| `Stop` | Runs when main agent finishes responding | No |
| `SubagentStop` | Runs when subagent tasks complete | No |
| `PreCompact` | Runs before compact operation | Yes (`manual`/`auto`) |
| `SessionStart` | Runs when session starts/resumes | Yes (`startup`/`resume`/`clear`/`compact`) |
| `SessionEnd` | Runs when session ends | No |

**Notification matchers**: `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`

### Hook configuration schema

Configuration files (in priority order): `~/.claude/settings.json` → `.claude/settings.json` → `.claude/settings.local.json` → Enterprise managed policy

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/script.sh",
            "timeout": 60
          }
        ]
      }
    ]
  }
}
```

**Schema fields**:
- **`matcher`**: (Optional) Pattern matching tool names. Supports regex (`Edit|Write`, `Notebook.*`). Use `*` or omit for all tools. Only for `PreToolUse`, `PermissionRequest`, `PostToolUse`.
- **`hooks`**: Array of hooks to execute
  - **`type`**: `"command"` for shell or `"prompt"` for LLM-based
  - **`command`**: Shell command to execute (for `type: "command"`)
  - **`prompt`**: LLM prompt (for `type: "prompt"`)
  - **`timeout`**: Seconds before cancellation (default: **60** for commands, **30** for prompts)

### Hook script interface

**stdin JSON input** (common fields):
```json
{
  "session_id": "string",
  "transcript_path": "string",
  "cwd": "string",
  "permission_mode": "default|plan|acceptEdits|bypassPermissions",
  "hook_event_name": "string"
}
```

**Event-specific input fields**:
- `PreToolUse`: `tool_name`, `tool_input`, `tool_use_id`
- `PostToolUse`: `tool_name`, `tool_input`, `tool_response`, `tool_use_id`
- `UserPromptSubmit`: `prompt`
- `Notification`: `message`, `notification_type`
- `PreCompact`: `trigger`, `custom_instructions`
- `SessionStart`: `source`
- `SessionEnd`: `reason`
- `Stop/SubagentStop`: `stop_hook_active`

**stdout JSON output**:
```json
{
  "continue": true,
  "stopReason": "string",
  "suppressOutput": true,
  "systemMessage": "string",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow|deny|ask",
    "permissionDecisionReason": "string",
    "updatedInput": {}
  }
}
```

### Exit codes determine blocking behavior

| Exit Code | Behavior |
|-----------|----------|
| **0** | Success. stdout parsed for structured control. |
| **2** | **Blocking error**. stderr fed to Claude. Blocks tool/permission/stop. |
| **Other** | Non-blocking error. Execution continues. |

**Environment variables available**:
- `CLAUDE_PROJECT_DIR` - Absolute path to project root
- `CLAUDE_CODE_REMOTE` - `"true"` for web environment
- `CLAUDE_ENV_FILE` - (SessionStart only) Path to persist environment variables
- `CLAUDE_PLUGIN_ROOT` - (Plugins only) Path to plugin directory

**Gaps**:
- `[NOT DOCUMENTED]`: Setup and PostToolUseFailure events (exist in SDK types)
- `[UNCLEAR IN DOCS]`: Exact precedence when hooks from multiple sources conflict

---

## MCP configuration

**Source**: https://code.claude.com/docs/en/mcp, https://code.claude.com/docs/en/settings  
**Last Verified**: January 24, 2026  
**Confidence**: HIGH

### Config file locations and precedence

| File | Location | Purpose |
|------|----------|---------|
| `~/.claude.json` | User home | User preferences, OAuth, MCP servers (user/local scope) |
| `.mcp.json` | Project root | Project-scoped MCP servers (team-shared via version control) |
| `managed-mcp.json` | System dirs | Enterprise-managed MCP servers |

**Enterprise managed MCP paths**:
- macOS: `/Library/Application Support/ClaudeCode/managed-mcp.json`
- Linux/WSL: `/etc/claude-code/managed-mcp.json`
- Windows: `C:\Program Files\ClaudeCode\managed-mcp.json`

**Scope precedence** (highest to lowest):
1. Enterprise managed (cannot be overridden)
2. Local scope (project-specific, private to user)
3. Project scope (team-shared via `.mcp.json`)
4. User scope (cross-project)

### Server configuration schema

**Stdio server**:
```json
{
  "mcpServers": {
    "server-name": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem"],
      "env": {"API_KEY": "your-key"},
      "cwd": "/optional/working/directory"
    }
  }
}
```

**HTTP server**:
```json
{
  "mcpServers": {
    "api-server": {
      "type": "http",
      "url": "${API_BASE_URL:-https://api.example.com}/mcp",
      "headers": {"Authorization": "Bearer ${API_KEY}"}
    }
  }
}
```

**Environment variable expansion**: `${VAR}` or `${VAR:-default}` supported in `command`, `args`, `env`, `url`, `headers`

### Tool search behavior

Tool Search activates when MCP tool descriptions consume **more than 10% of context window**. When triggered:
- Tools marked with `defer_loading: true`
- Claude uses search tool to discover relevant MCP tools
- Only needed tools loaded into context
- Requires Sonnet 4+/Opus 4+ (Haiku does NOT support)

**MCP output limits**: Warning at **10,000 tokens**, maximum **25,000 tokens** (configurable via `MAX_MCP_OUTPUT_TOKENS`)

### Permission handling for MCP tools

MCP tool permission format: `mcp__<server-name>__<tool-name>`

Wildcard syntax: `mcp__<server-name>__*`

```json
{
  "permissions": {
    "allow": ["mcp__github__*", "mcp__sentry__get_issues"],
    "deny": ["mcp__filesystem__delete_file"]
  }
}
```

**Project approval settings**:
- `enableAllProjectMcpServers`: Auto-approve all servers in project `.mcp.json`
- `enabledMcpjsonServers`: List of specific servers to approve
- `disabledMcpjsonServers`: List of specific servers to reject

**CLI commands**:
```bash
claude mcp add --transport http <name> <url>
claude mcp add --transport stdio <name> -- <command> [args...]
claude mcp add-json <name> '<json>'
claude mcp add-from-claude-desktop
claude mcp list
claude mcp remove <name>
claude mcp reset-project-choices
```

**Scope flags**: `--scope local` (default), `--scope project`, `--scope user`

**Gaps**:
- `[NOT DOCUMENTED]`: Exact defaults for `MCP_TIMEOUT` and `MCP_TOOL_TIMEOUT`
- `[NOT DOCUMENTED]`: Schema for `~/.claude.json` mcpServers structure
- `[UNCLEAR IN DOCS]`: `.claude/.mcp.json` vs project root `.mcp.json` behavior

---

## Settings and configuration

**Source**: https://code.claude.com/docs/en/settings, https://code.claude.com/docs/en/iam  
**Last Verified**: January 24, 2026  
**Confidence**: HIGH

### Settings file locations

| File | Path | Purpose |
|------|------|---------|
| User settings | `~/.claude/settings.json` | Global personal settings |
| Project settings | `.claude/settings.json` | Team-shared (version controlled) |
| Local project settings | `.claude/settings.local.json` | Personal project settings (auto-ignored by git) |
| Managed policy (macOS) | `/Library/Application Support/ClaudeCode/managed-settings.json` | Enterprise policies |
| Managed policy (Linux) | `/etc/claude-code/managed-settings.json` | Enterprise policies |
| Managed policy (Windows) | `C:\Program Files\ClaudeCode\managed-settings.json` | Enterprise policies |

### Complete settings.json schema

| Key | Type | Description |
|-----|------|-------------|
| `apiKeyHelper` | `string` | Script to generate auth value |
| `cleanupPeriodDays` | `number` | Days before inactive sessions deleted (default: 30) |
| `companyAnnouncements` | `string[]` | Announcements at startup |
| `env` | `object` | Environment variables for every session |
| `includeCoAuthoredBy` | `boolean` | Include co-authored-by byline (default: true) |
| `permissions` | `object` | Permission rules |
| `hooks` | `object` | Custom commands before/after tools |
| `disableAllHooks` | `boolean` | Disable all hooks |
| `model` | `string` | Override default model |
| `statusLine` | `object` | Custom status line configuration |
| `outputStyle` | `string` | Output style for system prompt |
| `forceLoginMethod` | `string` | Restrict login: `"claudeai"` or `"console"` |
| `forceLoginOrgUUID` | `string` | Auto-select organization UUID |
| `enableAllProjectMcpServers` | `boolean` | Auto-approve project MCP servers |
| `enabledMcpjsonServers` | `string[]` | Specific MCP servers to approve |
| `disabledMcpjsonServers` | `string[]` | Specific MCP servers to reject |
| `sandbox` | `object` | Sandbox configuration |
| `enabledPlugins` | `object` | Plugin enable/disable map |
| `autoUpdatesChannel` | `string` | `"latest"` (default) or `"stable"` |

### Permission settings schema

```json
{
  "permissions": {
    "allow": ["Bash(npm run lint)", "Read(~/.zshrc)"],
    "ask": ["Bash(git push:*)"],
    "deny": ["WebFetch", "Bash(curl:*)", "Read(./.env)"],
    "additionalDirectories": ["../docs/"],
    "defaultMode": "default",
    "disableBypassPermissionsMode": "disable"
  }
}
```

### Permission modes

| Mode | Description |
|------|-------------|
| `default` | Prompts for permission on first use of each tool |
| `acceptEdits` | Automatically accepts file edit permissions |
| `plan` | Claude can analyze but NOT modify files or execute commands |
| `bypassPermissions` | Skips ALL permission prompts (can be disabled) |

### Tool permission syntax

**Bash patterns** (prefix matching): `Bash(npm run test:*)`

**Read/Edit patterns** (gitignore-style):
- `//path` - Absolute from filesystem root
- `~/path` - From home directory
- `/path` - Relative to settings file
- `path` - Relative to current directory

**MCP patterns**: `mcp__puppeteer__*`, `mcp__puppeteer__puppeteer_navigate`

### Sandbox settings

```json
{
  "sandbox": {
    "enabled": true,
    "autoAllowBashIfSandboxed": true,
    "excludedCommands": ["git", "docker"],
    "allowUnsandboxedCommands": true,
    "network": {
      "allowUnixSockets": ["~/.ssh/agent-socket"],
      "allowLocalBinding": false
    }
  }
}
```

**Gaps**:
- `[NOT DOCUMENTED]`: Temperature/other model parameters in settings
- `[UNCLEAR IN DOCS]`: Full managed-settings.json schema differences

---

## File conventions

**Source**: https://docs.anthropic.com/en/docs/claude-code/slash-commands, https://docs.anthropic.com/de/docs/claude-code/memory, https://docs.anthropic.com/en/docs/claude-code/sub-agents  
**Last Verified**: January 24, 2026  
**Confidence**: HIGH

### CLAUDE.md files

**Purpose**: Persistent instructions ("memories") loaded at startup—coding conventions, commands, team instructions.

**Locations loaded** (recursive upward from cwd):
1. `./CLAUDE.md` or `./.claude/CLAUDE.md` (project)
2. Parent directories up to (but not including) root
3. `~/.claude/CLAUDE.md` (user-level)
4. `/Library/Application Support/ClaudeCode/CLAUDE.md` (macOS enterprise)

**Import syntax**: `@path/to/file.md` (recursive, max depth 5)

**Bootstrap**: Run `/init` to create initial CLAUDE.md

**View loaded files**: `/memory` command

**CLAUDE.local.md status**: `[DEPRECATED]` - Use imports (`@~/path/to/file.md`) instead, which work better across git worktrees.

### .claude/ directory structure

**Project-level** (`.claude/`):
```
.claude/
├── settings.json           # Team-shared settings
├── settings.local.json     # Local settings (not committed)
├── CLAUDE.md               # Alternative project memory location
├── commands/               # Custom slash commands
├── agents/                 # Custom subagents
├── skills/                 # Skills (directories with SKILL.md)
└── rules/                  # [MENTIONED IN CHANGELOG]
```

**User-level** (`~/.claude/`):
```
~/.claude/
├── settings.json           # User settings
├── CLAUDE.md               # User memories
├── commands/               # Personal commands
├── agents/                 # Personal subagents
├── skills/                 # Personal skills
├── output-styles/          # Custom output styles
├── plans/                  # Plan files storage
└── projects/               # Conversation history
```

### Skills (SKILL.md) format

Skills are directories containing `SKILL.md`. Commands in `.claude/commands/` still work with same format.

```markdown
---
name: my-skill
description: What this skill does
disable-model-invocation: true
user-invocable: false
allowed-tools: Read, Grep, Glob
context: fork
agent: Explore
model: claude-sonnet-4-5-20250929
argument-hint: [issue-number] [priority]
---
Your skill instructions here...
Use $ARGUMENTS or $1, $2 for user input.
Use !`shell command` for dynamic content.
Use @path/to/file for file injection.
```

**Frontmatter fields** (all optional):
| Field | Description |
|-------|-------------|
| `name` | Becomes /slash-command name |
| `description` | Helps Claude decide when to auto-load |
| `disable-model-invocation` | Only user can invoke (not Claude) |
| `user-invocable` | `false` = only Claude can invoke |
| `allowed-tools` | Comma-separated tool list |
| `context` | `fork` = run as isolated subagent |
| `agent` | Agent type (e.g., `Explore`) |
| `model` | Model override |
| `argument-hint` | Argument hint for users |

### Agents (.md) format

**Locations**: `.claude/agents/` (project), `~/.claude/agents/` (user)

```markdown
---
name: your-agent-name
description: When Claude should invoke this agent
tools: tool1, tool2, tool3
model: sonnet
---
Your subagent's system prompt here.
```

**Frontmatter**:
| Field | Description |
|-------|-------------|
| `name` | Agent identifier |
| `description` | Include "proactively" for auto-invocation |
| `tools` | Comma-separated (inherits all if omitted) |
| `model` | `sonnet`, `opus`, `haiku`, or `inherit` |

**Limitations**: Subagents cannot spawn other subagents. Agents loaded at startup only.

**Gaps**:
- `[UNCLEAR IN DOCS]`: `.claude/rules/` directory behavior
- `[NOT DOCUMENTED]`: Full plugin.json schema

---

## CLI interface

**Source**: https://code.claude.com/docs/en/settings, https://docs.anthropic.com/en/release-notes/claude-code  
**Last Verified**: January 24, 2026  
**Confidence**: HIGH

### CLI flags

| Flag | Description |
|------|-------------|
| `--model` | Override default model |
| `--permission-mode` | Set mode: `plan`, `acceptEdits`, `bypassPermissions` |
| `--allowed-tools` | Restrict which tools Claude can use |
| `--print` / `-p` | Non-interactive mode, print final result |
| `--output-format` | `text`, `json`, `stream-json` |
| `--input-format` | `stream-json` for streaming input |
| `--continue` / `-c` | Continue most recent conversation |
| `--resume` | Resume specific session (ID or name) |
| `--add-dir` | Add additional working directories |
| `--cwd` | Set working directory |
| `--system-prompt` | Replace system prompt entirely |
| `--append-system-prompt` | Add instructions while keeping defaults |
| `--system-prompt-file` | Load system prompt from file |
| `--append-system-prompt-file` | Append instructions from file |
| `--agents` | JSON object defining custom subagents |
| `--mcp-config` | Load MCP servers from JSON |
| `--strict-mcp-config` | Only use MCP from --mcp-config |
| `--settings` | Path to settings JSON or JSON string |
| `--dangerously-skip-permissions` | Bypass all permission checks |
| `--max-turns` | Maximum agentic turns |
| `--verbose` | Enable verbose output |

### Environment variables

**Authentication**:
- `ANTHROPIC_API_KEY` - API key for SDK authentication
- `ANTHROPIC_AUTH_TOKEN` - Custom Authorization header value

**Model configuration**:
- `ANTHROPIC_MODEL` - Model setting name
- `ANTHROPIC_DEFAULT_SONNET_MODEL` - Override Sonnet model
- `ANTHROPIC_DEFAULT_OPUS_MODEL` - Override Opus model
- `ANTHROPIC_DEFAULT_HAIKU_MODEL` - Override Haiku model
- `CLAUDE_CODE_SUBAGENT_MODEL` - Model for subagents

**Provider selection**:
- `CLAUDE_CODE_USE_BEDROCK` - Use Amazon Bedrock
- `CLAUDE_CODE_USE_VERTEX` - Use Google Vertex AI
- `CLAUDE_CODE_USE_FOUNDRY` - Use Microsoft Foundry

**Feature flags**:
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` - Disable autoupdater, bug command, telemetry
- `DISABLE_AUTOUPDATER` - Disable auto-updates
- `DISABLE_TELEMETRY` - Opt out of telemetry

**Limits**:
- `MAX_THINKING_TOKENS` - Extended thinking token budget
- `MAX_MCP_OUTPUT_TOKENS` - Max MCP response tokens (default: 25000)
- `BASH_DEFAULT_TIMEOUT_MS` - Default bash timeout
- `BASH_MAX_TIMEOUT_MS` - Maximum bash timeout

**Storage**:
- `CLAUDE_CONFIG_DIR` - Customize config/data storage location
- `CLAUDE_CODE_TMPDIR` - Override temp directory

**Gaps**:
- `[NOT DOCUMENTED]`: `--debug`, `--fallback-model`, `--replay-user-messages` flags
- `[VERIFY: may have changed]`: Some flags may be SDK-only

---

## Storage and paths

**Source**: https://code.claude.com/docs/en/settings  
**Last Verified**: January 24, 2026  
**Confidence**: MEDIUM

### User configuration

| Path | Description |
|------|-------------|
| `~/.claude/settings.json` | User settings |
| `~/.claude/CLAUDE.md` | User memories |
| `~/.claude/commands/` | Personal slash commands |
| `~/.claude/agents/` | Personal subagents |
| `~/.claude/skills/` | Personal skills |
| `~/.claude.json` | Preferences, OAuth, MCP configs, caches |

### Project configuration

| Path | Description |
|------|-------------|
| `.claude/settings.json` | Project settings (version controlled) |
| `.claude/settings.local.json` | Local settings (not committed) |
| `.mcp.json` | Project MCP servers |
| `CLAUDE.md` | Project memory |

### Session and conversation storage

- **Default location** (v1.0.30+): `~/.config/claude/projects/`
- **Legacy location**: `~/.claude/projects/`
- Sessions stored per project directory (organized by git repo)
- `cleanupPeriodDays` setting controls retention (default: **30 days**)
- `CLAUDE_CONFIG_DIR` environment variable customizes storage location

### Enterprise managed paths

| Platform | Settings | MCP |
|----------|----------|-----|
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.json` | `/Library/Application Support/ClaudeCode/managed-mcp.json` |
| Linux/WSL | `/etc/claude-code/managed-settings.json` | `/etc/claude-code/managed-mcp.json` |
| Windows | `C:\Program Files\ClaudeCode\managed-settings.json` | `C:\Program Files\ClaudeCode\managed-mcp.json` |

**Note**: `C:\ProgramData\ClaudeCode\` is `[DEPRECATED]`.

**Gaps**:
- `[NOT DOCUMENTED]`: Exact session file paths and format
- `[NOT DOCUMENTED]`: Cache file locations
- `[NOT DOCUMENTED]`: Conversation history file format
- `[UNCLEAR IN DOCS]`: XDG Base Directory compliance specifics

---

## Summary of documentation gaps

**Hooks**:
- Setup and PostToolUseFailure events (exist in SDK types but undocumented)
- Hook conflict resolution when multiple sources match

**MCP**:
- Default values for MCP_TIMEOUT and MCP_TOOL_TIMEOUT
- ~/.claude.json mcpServers schema for direct editing
- Tool Search disable mechanism

**Settings**:
- Temperature and model parameters beyond model name
- Formal JSON Schema (exists at json.schemastore.org but not in docs)

**Files**:
- .claude/rules/ directory behavior
- Full plugin.json schema

**CLI**:
- Several flags in --help not in docs (--debug, --fallback-model)

**Storage**:
- Exact session file paths and format
- Cache locations
- XDG compliance details

---

*All information sourced exclusively from official Anthropic documentation: code.claude.com/docs/*, docs.anthropic.com/en/docs/claude-code/*, and github.com/anthropics/claude-code.*