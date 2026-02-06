# session-archive

Archive old Claude Code session transcripts with zstd compression. Runs automatically on session start via hook, or manually via slash command.

## Requirements

- **bun** -- TypeScript runtime
- **zstd** -- compression (typically 80-90% size reduction on JSONL transcripts)
- **flock** -- concurrency guard (part of `util-linux`, pre-installed on most Linux)

## Setup

### 1. Symlink the slash command

```bash
ln -sf ~/projects/claude-plugins/session-archive/session-archive.md ~/.claude/commands/session-archive.md
```

### 2. Add SessionStart hook to settings.json

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/projects/claude-plugins/session-archive/sessionstart-archive.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

## Usage

### Slash command

```
/session-archive --stats          # Show archive statistics (default)
/session-archive --list           # List all archived sessions
/session-archive --dry-run        # Preview what would be archived
/session-archive --verbose        # Archive with detailed output
/session-archive --days 14        # Archive sessions older than 14 days (default: 30)
/session-archive --project <path> # Target a specific project directory
/session-archive --unarchive <uuid> --project <path>  # Restore a session
```

### Direct invocation

```bash
bun ~/projects/claude-plugins/session-archive/session-archive.ts --stats
```

## How the hook works

On every `SessionStart`:

1. `sessionstart-archive.sh` checks that `bun` and `zstd` are available (exits silently if not)
2. Acquires a file lock (`flock`) to prevent concurrent runs
3. Reads the session ID from stdin (Claude provides this as JSON) to protect the current session
4. Archives up to 20 sessions per invocation (oldest first) that are older than 30 days
5. Skips active sessions (detected via `/tmp/claude-*/tasks/` symlinks)
6. Outputs `{"suppressOutput": true}` so Claude doesn't display anything

## Archive structure

Inside each `~/.claude/projects/<project>/`:

```
archive/
├── sessions-index.json           # Index of all archived sessions
├── <uuid>.jsonl.zst              # Compressed transcript
├── <uuid>.jsonl                  # Empty transcripts (moved as-is)
└── <uuid>/                       # Session directory (if present)
```

The index tracks original size, compressed size, archive date, and what components each session had (JSONL, directory, or both).
