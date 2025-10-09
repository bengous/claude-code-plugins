#!/usr/bin/env python3
"""
worktree-guard hook

Blocks direct git worktree / git branch -D usage inside Claude sessions so agents
rely on the managed /worktree CLI instead. We intentionally do NOT expose an
escape hatch (e.g. env flags) because previous experiments showed the model
would repeat the bypass token. Humans can still run the raw git commands from
regular shells; if this hook fires, it means the CLI needs to be fixed rather
than bypassed.
"""

import json
import shlex
import sys

try:
    payload = json.load(sys.stdin)
except Exception:
    payload = {}

cmd = payload.get("command")
if not cmd:
    sys.exit(0)

# Handle both string and array formats (Claude Code sends strings)
if isinstance(cmd, str):
    argv = shlex.split(cmd)
elif isinstance(cmd, list):
    argv = cmd
else:
    sys.exit(0)

BLOCKED = {
    ("git", "worktree", "add"),
    ("git", "worktree", "remove"),
    ("git", "worktree", "prune"),
    ("git", "worktree", "move"),
    ("git", "worktree", "repair"),
    ("git", "branch", "-D"),
}

GUIDE = """
🚫 Blocked raw git worktree/branch command: {cmd}

This bypasses worktree management. Use the CLI instead:
  • /worktree delete <name>      remove a worktree safely
  • /worktree prune --force      clean up several at once
  • /worktree list [--json]      inspect managed worktrees

"""

def match(block):
    if len(argv) < len(block):
        return False
    return all(argv[i] == block[i] for i in range(len(block)))

for block in BLOCKED:
    if match(block):
        cmd = " ".join(shlex.quote(part) for part in argv)
        sys.stdout.write(GUIDE.format(cmd=cmd))
        sys.exit(2)

sys.exit(0)
