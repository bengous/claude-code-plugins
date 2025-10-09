#!/bin/bash
# UserPromptSubmit hook: Enforce plan mode for /orc:start
set -euo pipefail

# Read hook input from stdin
input=$(cat)

# Extract the user prompt
prompt=$(echo "${input}" | jq -r '.prompt // empty')

# Check if prompt starts with /orc:start
if [[ ! "${prompt}" =~ ^/orc:start ]]; then
	# Not an /orc:start command, allow
	exit 0
fi

# Check if we're already in plan mode or if plan was approved
# This is indicated by the presence of a "plan approved" marker
marker_file=".claude/run/orc-plan-approved"

if [[ -f "${marker_file}" ]]; then
	# Plan was approved, allow execution and clean up marker
	rm -f "${marker_file}"
	exit 0
fi

# Check if this looks like a plan mode classification response
# (contains "PHASE 1" or "Task Classification" or "Path chosen")
if [[ "${prompt}" =~ "PHASE 1" ]] || [[ "${prompt}" =~ "Task Classification" ]] || [[ "${prompt}" =~ "Path chosen" ]]; then
	# This is a plan response, allow it
	exit 0
fi

# First time seeing /orc:start, enforce plan mode
# We do this by outputting a message to stderr which Claude sees
cat >&2 <<EOF

📋 Plan Mode Enforced for /orc:start

The /orc:start command requires a planning phase first.

You must:
1. Analyze the task
2. Classify as SIMPLE/MEDIUM/COMPLEX
3. Present your plan and rationale
4. Wait for user approval before execution

Please proceed with PHASE 1: Task Classification.

EOF

# Note: We allow the command to proceed because the command itself
# contains the plan mode logic. We're just nudging here.
exit 0
