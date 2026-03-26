# session-archive

Archive old Claude Code session transcripts with gzip compression (via Bun built-in). Runs automatically on session start via hook, or manually via slash command.

## Requirements

- **bun** -- TypeScript runtime (compression and file I/O handled natively)
- **zstd** -- only needed to restore legacy archives compressed with zstd

## Setup

### 1. Symlink the slash command (optional)

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
            "command": "bun ~/projects/claude-plugins/session-archive/session-archive.ts --hook",
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

1. Acquires a PID-based lockfile (with stale lock detection) to prevent concurrent runs
2. Reads the session ID from stdin (Claude provides this as JSON) to protect the current session
3. Archives up to 20 sessions per invocation (oldest first) that are older than 30 days
4. Compresses JSONL transcripts using `Bun.gzipSync()` (no external tools needed)
5. Skips active sessions (detected via `/tmp/claude-*/tasks/` symlinks)
6. Outputs `{"suppressOutput": true}` so Claude doesn't display anything
7. Always exits 0 in hook mode -- errors are logged to stderr, never crash the session

## Archive structure

Inside each `~/.claude/projects/<project>/`:

```
archive/
├── sessions-index.json           # Index of all archived sessions
├── <uuid>.jsonl.gz               # Gzip-compressed transcript (new)
├── <uuid>.jsonl.zst              # Zstd-compressed transcript (legacy)
├── <uuid>.jsonl                  # Empty transcripts (moved as-is)
└── <uuid>/                       # Session directory (if present)
```

The index tracks original size, compressed size, archive date, compression format, and what components each session had (JSONL, directory, or both).

## Migration from v1 (zstd)

Existing `.zst` archives are preserved and can still be restored (requires `zstd` CLI). New archives use gzip via Bun's built-in `Bun.gzipSync()`. The `--list` command shows the format for each archived session.
