#!/bin/bash
# PreToolUse hook: Guard against creating PRs to dev from non-base branches in COMPLEX mode
set -euo pipefail

# Read hook input from stdin
input=$(cat)

# Extract tool name and check if it's a SlashCommand
tool_name=$(echo "${input}" | jq -r '.tool_name // empty')

# Only check SlashCommand invocations
if [[ "${tool_name}" != "SlashCommand" ]]; then
	exit 0
fi

# Extract the slash command being invoked
command=$(echo "${input}" | jq -r '.tool_input.command // empty')

# Only check /claude-orchestration:pr:create commands
if [[ ! "${command}" =~ ^/claude-orchestration:pr:create ]]; then
	exit 0
fi

# Check if we have orchestration state
state_file=".claude/run/current.json"
if [[ ! -f "${state_file}" ]]; then
	# No state file, allow (not in orchestrated mode)
	exit 0
fi

# Read orchestration type
orch_type=$(jq -r '.type // empty' "${state_file}" 2>/dev/null || echo "")

# If not COMPLEX, allow
if [[ "${orch_type}" != "COMPLEX" ]]; then
	exit 0
fi

# For COMPLEX mode, check if PR is targeting dev
base_branch=$(jq -r '.base // "dev"' "${state_file}")
current_branch=$(git branch --show-current)

# Parse the command arguments to see if --base dev is specified
if [[ "${command}" =~ --base[[:space:]]+dev ]] || [[ "${command}" =~ --base=dev ]]; then
	# Check if current branch is the base branch
	if [[ "${current_branch}" != "${base_branch}" ]]; then
		cat >&2 <<EOF

🚫 BLOCKED: Invalid PR target for COMPLEX orchestration

You are in COMPLEX mode with base branch: ${base_branch}
Current branch: ${current_branch}

COMPLEX mode policy:
  - Sub-PRs must target the base branch (${base_branch}), not dev
  - Only the final PR from base branch to dev is allowed
  - Current command would create PR from ${current_branch} to dev

Correct approach:
  1. Create sub-PRs: /pr:create --head ${current_branch} --base ${base_branch}
  2. After all sub-PRs merged, create final PR: /pr:create --head ${base_branch} --base dev

If you believe this is the final PR:
  1. Ensure you're on the base branch: git checkout ${base_branch}
  2. Then run: /pr:create --base dev

EOF
		exit 1
	fi
fi

# Allow all other cases
exit 0
