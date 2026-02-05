# LSP Tools in Claude Code

Enable semantic code navigation in Claude Code using Language Server Protocol.

## What LSP Provides

Instead of grep-based text matching, LSP understands code semantically:

| Operation | Description | Example |
|-----------|-------------|---------|
| `goToDefinition` | Jump to where a symbol is defined | Find function implementation |
| `findReferences` | All usages of a symbol | Who calls this function? |
| `hover` | Type info and documentation | What type does this return? |
| `documentSymbol` | All symbols in a file | List classes, functions, constants |
| `workspaceSymbol` | Search symbols by name | Find all classes named `*Service` |
| `goToImplementation` | Find interface implementations | Which classes implement this? |
| `incomingCalls` | Call hierarchy - callers | What calls this function? |
| `outgoingCalls` | Call hierarchy - callees | What does this function call? |

## Setup

### 1. Install a Language Server

```bash
# Python (pyright)
npm install -g pyright
# or: pip install pyright (in a venv)

# TypeScript/JavaScript
npm install -g typescript-language-server typescript

# Go
go install golang.org/x/tools/gopls@latest

# Rust
# Install via rustup: https://rust-analyzer.github.io/manual.html#installation
```

### 2. Install the LSP Plugin

```bash
claude plugin install pyright-lsp        # Python
claude plugin install typescript-lsp     # TypeScript/JS
```

### 3. Enable the LSP Tool

The LSP tool is gated behind an environment variable:

```bash
# One-time launch
ENABLE_LSP_TOOL=1 claude

# Permanent (add to ~/.bashrc or ~/.zshrc)
export ENABLE_LSP_TOOL=1
```

### 4. Verify Setup

Start Claude Code and ask it to use LSP:

```
Use LSP to list all symbols in src/main.py
```

Or check if the tool is available:
```
Do you have an LSP tool?
```

## Tool Interface

The LSP tool is a unified built-in tool with an operation parameter:

```
LSP(
  operation: "goToDefinition" | "findReferences" | "hover" |
             "documentSymbol" | "workspaceSymbol" | "goToImplementation" |
             "prepareCallHierarchy" | "incomingCalls" | "outgoingCalls",
  filePath: string,      # Absolute path to file
  line: number,          # 1-indexed line number
  character: number      # 1-indexed column position
)
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│ Claude Code                                         │
├─────────────────────────────────────────────────────┤
│ Built-in tools:                                     │
│   Read, Edit, Write, Bash, Glob, Grep, ...          │
│                                                     │
│ Conditional built-in (ENABLE_LSP_TOOL=1):           │
│   LSP  ←── JSON-RPC ──→  pyright / tsserver / ...   │
│              ↑                                      │
│              └── configured by LSP plugins          │
└─────────────────────────────────────────────────────┘
```

The LSP tool is built into Claude Code but only activated when:
1. `ENABLE_LSP_TOOL=1` is set
2. An LSP plugin provides server configuration

LSP plugins don't contain language servers - they configure how Claude Code connects to servers you install separately.

## Troubleshooting

### "No LSP server available for file type"

1. Check if the language server is installed and in PATH:
   ```bash
   which pyright  # Should return a path
   ```

2. Check if the plugin is enabled:
   ```bash
   claude plugin list | grep lsp
   ```

3. Restart Claude Code after installing plugins

### LSP operations return empty results

1. Ensure you're in a project directory (LSP needs workspace context)
2. Check for pyright/tsconfig errors - the language server might be failing silently
3. Run with debug logging:
   ```bash
   ENABLE_LSP_TOOL=1 claude --debug
   ```

### Known Issues

- LSP Manager sometimes initializes before plugins load ([#13952](https://github.com/anthropics/claude-code/issues/13952))
- Some language servers don't work with native binary installation ([#20050](https://github.com/anthropics/claude-code/issues/20050))

## Available LSP Plugins

| Language | Plugin | Binary to install |
|----------|--------|-------------------|
| Python | `pyright-lsp` | `npm i -g pyright` |
| TypeScript/JS | `typescript-lsp` | `npm i -g typescript-language-server typescript` |
| Go | (community) | `gopls` |
| Rust | (community) | `rust-analyzer` |

Check the [official plugins repo](https://github.com/anthropics/claude-plugins-official) for the latest LSP plugins.

## Performance

LSP provides ~50ms navigation vs multi-second grep searches because:
- Language servers maintain an in-memory index of your codebase
- The index updates incrementally as files change
- Queries hit the index, not the filesystem

Memory overhead: 200-500MB for small-to-medium projects.

## References

- [Claude Code Plugins Reference - LSP Servers](https://code.claude.com/docs/en/plugins-reference)
- [GitHub Issues - LSP](https://github.com/anthropics/claude-code/issues?q=LSP)
- [Release Notes v2.0.74](https://github.com/anthropics/claude-code/releases) - LSP tool introduction
