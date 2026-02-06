#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v bun >/dev/null 2>&1 || exit 0
command -v zstd >/dev/null 2>&1 || exit 0

exec flock -w 5 "/tmp/session-archive-${UID}.lock" \
  bun run "$SCRIPT_DIR/session-archive.ts" --hook "$@" \
  || exit 0
