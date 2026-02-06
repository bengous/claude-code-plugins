---
description: Archive old Claude Code sessions or restore archived ones
argument-hint: "[--stats|--list|--dry-run|--unarchive <uuid>] [--days N] [--project <path>] [--verbose]"
allowed-tools:
  - Bash(bun:*)
model: haiku
---

# Session Archive

Manage archived Claude Code session transcripts.

**Resolve script path:**
```bash
SCRIPT="$(dirname "$(realpath ~/.claude/commands/session-archive.md)")/session-archive.ts"
```

**Your task:** Execute the session-archive tool:

```bash
bun "$SCRIPT" $ARGUMENTS
```

If `$ARGUMENTS` is empty, run with `--stats` as default.

Report the output to the user.
