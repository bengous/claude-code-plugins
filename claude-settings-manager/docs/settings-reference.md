# Claude Code Settings Reference

Complete reference for `settings.json` configuration options.

> Source: [Official Claude Code Documentation](https://code.claude.com/docs/en/settings)

## Settings Files

| Location | Scope | Purpose |
|----------|-------|---------|
| `~/.claude/settings.json` | User | Global settings for all projects |
| `.claude/settings.json` | Project | Shared team settings (committed) |
| `.claude/settings.local.json` | Project | Personal overrides (not committed) |
| `/etc/claude-code/managed-settings.json` | Enterprise | Managed policies (Linux/WSL) |
| `/Library/Application Support/ClaudeCode/managed-settings.json` | Enterprise | Managed policies (macOS) |

## Core Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `apiKeyHelper` | string | — | Script path that outputs auth value for API requests |
| `awsAuthRefresh` | string | — | Script that modifies `.aws` directory for credential refresh |
| `awsCredentialExport` | string | — | Script that outputs AWS credentials as JSON |
| `cleanupPeriodDays` | number | `30` | Days to retain inactive sessions before cleanup |
| `env` | object | `{}` | Environment variables for all sessions |
| `includeCoAuthoredBy` | boolean | `true` | Include `co-authored-by Claude` in commits/PRs |
| `model` | string | — | Override default model (e.g., `claude-sonnet-4-20250514`) |
| `outputStyle` | string | — | Output style adjustment (e.g., `"Explanatory"`) |
| `statusLine` | object | — | Custom status line configuration |
| `disableAllHooks` | boolean | `false` | Disable all hooks and statusLine execution |
| `hooks` | object | — | Custom commands for tool events (see Hooks section) |

## Permission Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `permissions.allow` | string[] | `[]` | Rules to allow tool use without prompting |
| `permissions.ask` | string[] | `[]` | Rules to always prompt for confirmation |
| `permissions.deny` | string[] | `[]` | Rules to block tool use entirely |
| `permissions.additionalDirectories` | string[] | `[]` | Extra directories Claude can access |
| `permissions.defaultMode` | string | `"default"` | Default mode: `"default"`, `"acceptEdits"`, `"plan"` |
| `permissions.disableBypassPermissionsMode` | string | — | Set to `"disable"` to block `--dangerously-skip-permissions` |

### Permission Rule Syntax

```
ToolName(pattern)
```

Examples:
- `Bash(git:*)` - Allow all git commands
- `Bash(npm run test:*)` - Allow npm test with any suffix
- `Read(.env)` - Match .env file
- `Read(./secrets/**)` - Match all files in secrets directory
- `WebFetch(domain:github.com)` - Allow fetching from github.com

## Sandbox Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `sandbox.enabled` | boolean | `false` | Enable bash sandboxing (macOS/Linux) |
| `sandbox.autoAllowBashIfSandboxed` | boolean | `true` | Auto-approve bash when sandboxed |
| `sandbox.excludedCommands` | string[] | `[]` | Commands that bypass sandbox |
| `sandbox.allowUnsandboxedCommands` | boolean | `true` | Allow `dangerouslyDisableSandbox` parameter |
| `sandbox.enableWeakerNestedSandbox` | boolean | `false` | Weaker sandbox for Docker (Linux) |
| `sandbox.network.allowUnixSockets` | string[] | `[]` | Unix socket paths accessible in sandbox |
| `sandbox.network.allowLocalBinding` | boolean | `false` | Allow binding to localhost (macOS) |
| `sandbox.network.httpProxyPort` | number | — | HTTP proxy port for sandbox |
| `sandbox.network.socksProxyPort` | number | — | SOCKS5 proxy port for sandbox |

## Plugin & MCP Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabledPlugins` | object | `{}` | Plugin states: `"plugin@marketplace": true/false` |
| `extraKnownMarketplaces` | object | `{}` | Additional marketplace definitions |
| `pluginConfigs` | object | `{}` | Per-plugin configuration |
| `enableAllProjectMcpServers` | boolean | `false` | Auto-approve all MCP servers in `.mcp.json` |
| `enabledMcpjsonServers` | string[] | `[]` | Specific MCP servers to approve |
| `disabledMcpjsonServers` | string[] | `[]` | Specific MCP servers to reject |

## Enterprise Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `companyAnnouncements` | string[] | `[]` | Announcements shown at startup (cycled randomly) |
| `forceLoginMethod` | string | — | Force `"claudeai"` or `"console"` login |
| `forceLoginOrgUUID` | string | — | Organization UUID to auto-select |
| `allowedMcpServers` | object[] | — | Managed allowlist of MCP servers |
| `deniedMcpServers` | object[] | — | Managed denylist of MCP servers |
| `skipWebFetchPreflight` | boolean | `false` | Skip WebFetch blocklist (enterprise) |
| `otelHeadersHelper` | string | — | Script that outputs OpenTelemetry headers |
| `spinnerTipsEnabled` | boolean | `true` | Show tips in loading spinner |
| `alwaysThinkingEnabled` | boolean | `false` | Always enable extended thinking |

## Hooks Configuration

```json
{
  "hooks": {
    "PreToolUse": {
      "Bash": "echo 'Running command...'"
    },
    "PostToolUse": {
      "Edit": ["ruff format $FILE", "ruff check --fix $FILE"]
    }
  }
}
```

Hook events: `PreToolUse`, `PostToolUse`, `Notification`, `Stop`

## Example Configuration

```jsonc
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",

  // Model override
  "model": "claude-sonnet-4-20250514",

  // Permissions
  "permissions": {
    "allow": [
      "Bash(git:*)",
      "Bash(npm run:*)",
      "Read(~/.zshrc)"
    ],
    "deny": [
      "Read(.env)",
      "Read(.env.*)",
      "Read(./secrets/**)"
    ],
    "defaultMode": "acceptEdits"
  },

  // Environment
  "env": {
    "NODE_ENV": "development"
  },

  // Sandbox (macOS/Linux)
  "sandbox": {
    "enabled": true,
    "excludedCommands": ["docker"],
    "network": {
      "allowUnixSockets": ["/var/run/docker.sock"]
    }
  }
}
```

## See Also

- [Official Settings Docs](https://code.claude.com/docs/en/settings)
- [Hooks Documentation](https://code.claude.com/docs/en/hooks)
- [IAM & Permissions](https://code.claude.com/docs/en/iam)
- [JSON Schema](https://json.schemastore.org/claude-code-settings.json)
