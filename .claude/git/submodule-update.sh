#!/usr/bin/env bash
# Auto-update submodules after merge/pull
set -euo pipefail
git submodule update --init --recursive
