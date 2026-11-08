# session-archive

Archive old Claude Code session transcripts with zstd compression (via Bun built-in). Runs automatically on session start via hook, or manually via slash command.

A personal tool, not a marketplace plugin: it has no entry in `.claude-plugin/marketplace.json` and no row in the root `README.md` table. `/plugin install` cannot reach it; wire it by hand as below. Substitute your own clone path for `/path/to/claude-code-plugins`.

## Requirements

- **bun** -- TypeScript runtime (compression and file I/O handled natively)

No external tool is required. Bun compresses and decompresses both zstd and gzip.

## Setup

### 1. Symlink the slash command (optional)

```bash
ln -sf /path/to/claude-code-plugins/session-archive/session-archive.md ~/.claude/commands/session-archive.md
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
            "command": "bun /path/to/claude-code-plugins/session-archive/session-archive.ts --hook",
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
/session-archive --days 14        # Archive sessions without a message for 14 days (default: 90)
/session-archive --project <path> # Target a specific project directory
/session-archive --unarchive <uuid> --project <path>  # Restore a session
```

### Direct invocation

```bash
bun /path/to/claude-code-plugins/session-archive/session-archive.ts --stats
```

## How the hook works

On every `SessionStart`:

1. Outputs `{"suppressOutput": true}` so Claude doesn't display anything, and hands the work to a detached background process
2. Does nothing at all unless the session's transcript lives under `~/.claude/projects` (the grandparent of `transcript_path`, both resolved): a profile such as `~/.claudex` or `~/.oxa` that inherits the hook keeps its sessions untouched
3. Runs at most once every 6 hours, under a PID-based lockfile (with stale lock detection)
4. Protects the current session (its ID from stdin), active sessions (detected via `/tmp/claude-*/tasks/` symlinks) and transcripts modified in the last 5 minutes
5. Scans every project of `~/.claude/projects` and archives up to 20 sessions per pass, oldest first, that have had no message for 90 days
6. Always exits 0 in hook mode; a session it kept, and why, goes to `~/.claude/.session-archive-errors.log`

## When a session is old enough

A session's last activity is the last `"timestamp"` field of its transcript, read from the end of the file, or the file's mtime when the transcript has none. A session is eligible once that date is older than `--days` (90 by default).

## When an original is deleted

The tool deletes a transcript from `~/.claude/projects` only when all of these hold; otherwise the transcript stays, nothing is indexed, the `.zst` written for it is removed, and the reason is reported:

1. the vault holds a copy with the same sha256, at `<vault>/<project directory name>/<uuid>.jsonl`, checked before compressing; the vault root is `$SESSION_ARCHIVE_VAULT`, by default `~/.claude-archives/miroir/claude/projects`
2. the `.zst` is fsynced (the file, then its directory after the rename), read back from disk and decompresses to exactly the bytes that were compressed
3. the transcript kept its inode, size and mtime from the moment it was read to the moment it is deleted, so a message appended in between keeps it

The session's `<uuid>/` directory is moved into `archive/` only after its transcript passed these checks. `--copy` never deletes and needs no vault copy. `--dry-run` writes nothing and checks the vault copy by existence and size only.

## Archive structure

Inside each `~/.claude/projects/<project>/`:

```
archive/
├── sessions-index.json           # Index of all archived sessions
├── <uuid>.jsonl.zst              # Zstd-compressed transcript (current)
├── <uuid>.jsonl.gz               # Gzip-compressed transcript (legacy)
├── <uuid>.jsonl                  # Empty transcripts (moved as-is)
└── <uuid>/                       # Session directory (if present)
```

The index tracks original size, compressed size, archive date, compression format, and what components each session had (JSONL, directory, or both).

## Archive formats

New archives use `Bun.zstdCompressSync()`. On a 2.17 MB transcript it produced 371 KB in
6 ms, against 476 KB in 15 ms for gzip.

Both older formats still restore, and neither needs a CLI any more:

- `.jsonl.gz`, written while the tool used gzip, via `Bun.gunzipSync()`
- `.jsonl.zst`, written by v1, via `Bun.zstdDecompressSync()`

v1 shelled out to the `zstd` binary, which is why the tool moved to gzip. Bun gained
native zstd in 1.2.14, so that reason is gone. The `--list` command shows the format
for each archived session.
