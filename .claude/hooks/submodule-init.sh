#!/usr/bin/env bash
# SessionStart hook: ensure submodules are initialized (no fetch, fast)
set -euo pipefail

# Check if any submodule is uninitialized
if git submodule status 2>/dev/null | grep -q '^-'; then
  echo "Initializing submodules..."
  git submodule update --init --recursive
fi
