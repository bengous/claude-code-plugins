#!/usr/bin/env bash
set -euo pipefail

# Configuration
SCRIPT_DIR="$(dirname "$0")"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"

# Default values
BRANCH=""
OUTPUT_FILE=""
LIMIT=100

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch)
      BRANCH="$2"
      shift 2
      ;;
    --output)
      OUTPUT_FILE="$2"
      shift 2
      ;;
    --limit)
      LIMIT="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: /bisect-ci [--branch <branch>] [--output <file>] [--limit <num>]"
      exit 1
      ;;
  esac
done

# Get current branch if not specified
if [[ -z "$BRANCH" ]]; then
  BRANCH=$(git branch --show-current)
  echo "Using current branch: $BRANCH"
fi

# Set default output file if not specified
if [[ -z "$OUTPUT_FILE" ]]; then
  TIMESTAMP=$(date +%Y%m%d-%H%M%S)
  OUTPUT_FILE="$PROJECT_DIR/temp/ci-bisect-$TIMESTAMP.txt"
fi

# Ensure output directory exists
mkdir -p "$(dirname "$OUTPUT_FILE")"

echo "=== GitHub Actions CI Bisector ==="
echo "Branch: $BRANCH"
echo "Limit: $LIMIT runs"
echo "Output: $OUTPUT_FILE"
echo ""

# Step 1: Get GitHub Actions runs for "CI" workflow only
echo "Fetching GitHub Actions CI runs..."
RUNS_JSON=$(gh run list --branch "$BRANCH" --limit "$LIMIT" --json headSha,conclusion,url,databaseId,workflowName)

# Filter to only "CI" workflow (exclude validator package CI)
CI_RUNS=$(echo "$RUNS_JSON" | jq '[.[] | select(.workflowName == "CI")]')

if [[ $(echo "$CI_RUNS" | jq 'length') -eq 0 ]]; then
  echo "No CI runs found for branch: $BRANCH"
  exit 1
fi

echo "Found $(echo "$CI_RUNS" | jq 'length') CI runs"

# Step 2: Get git log
echo "Getting git log..."
GIT_LOG=$(git log --oneline -100)

# Step 3: Build mapping of commit SHA to runs
declare -A COMMIT_RUNS
while IFS= read -r line; do
  SHA=$(echo "$line" | jq -r '.headSha')
  CONCLUSION=$(echo "$line" | jq -r '.conclusion')
  URL=$(echo "$line" | jq -r '.url')

  # Get short SHA (first 8 chars)
  SHORT_SHA="${SHA:0:8}"

  # Map conclusion to display text
  case "$CONCLUSION" in
    success) STATUS="SUCCESS" ;;
    failure) STATUS="FAILURE" ;;
    cancelled) STATUS="CANCELLED" ;;
    *) STATUS="$CONCLUSION" ;;
  esac

  # Store run info for this commit
  if [[ -n "${COMMIT_RUNS[$SHORT_SHA]:-}" ]]; then
    COMMIT_RUNS[$SHORT_SHA]="${COMMIT_RUNS[$SHORT_SHA]} | $STATUS $URL"
  else
    COMMIT_RUNS[$SHORT_SHA]="$STATUS $URL"
  fi
done < <(echo "$CI_RUNS" | jq -c '.[]')

# Step 4: Find last known good and first known bad
LAST_GOOD=""
FIRST_BAD=""
IN_SUSPECT_RANGE=false

while IFS= read -r line; do
  SHORT_SHA=$(echo "$line" | awk '{print $1}')

  if [[ -n "${COMMIT_RUNS[$SHORT_SHA]:-}" ]]; then
    RUN_INFO="${COMMIT_RUNS[$SHORT_SHA]}"

    if [[ "$RUN_INFO" =~ SUCCESS ]] && [[ -z "$LAST_GOOD" ]] && [[ "$IN_SUSPECT_RANGE" == false ]]; then
      LAST_GOOD="$SHORT_SHA"
    fi

    if [[ "$RUN_INFO" =~ FAILURE ]] && [[ -z "$FIRST_BAD" ]]; then
      FIRST_BAD="$SHORT_SHA"
      IN_SUSPECT_RANGE=true
    fi
  fi
done < <(echo "$GIT_LOG")

echo "Last known good: ${LAST_GOOD:-none found}"
echo "First known bad: ${FIRST_BAD:-none found}"
echo ""

# Step 5: Generate output file
{
  if [[ -n "$FIRST_BAD" ]]; then
    echo "╔════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════"
    echo "║ SUSPECT RANGE START (HEAD) - Bug still present"
    echo "╚════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════"
  fi

  IN_RANGE=false
  if [[ -n "$FIRST_BAD" ]]; then
    IN_RANGE=true
  fi

  while IFS= read -r line; do
    SHORT_SHA=$(echo "$line" | awk '{print $1}')
    MESSAGE=$(echo "$line" | cut -d' ' -f2-)

    # Check if we've reached last known good
    if [[ "$SHORT_SHA" == "$LAST_GOOD" ]]; then
      if [[ "$IN_RANGE" == true ]]; then
        echo "╔════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════"
        echo "║ SUSPECT RANGE END - Bug introduced somewhere between here and HEAD"
        echo "╚════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════"
      fi
      IN_RANGE=false
    fi

    # Print commit line
    if [[ -n "${COMMIT_RUNS[$SHORT_SHA]:-}" ]]; then
      RUN_INFO="${COMMIT_RUNS[$SHORT_SHA]}"

      if [[ "$SHORT_SHA" == "$LAST_GOOD" ]]; then
        echo "$SHORT_SHA $MESSAGE ◄── $RUN_INFO [LAST KNOWN GOOD]"
      elif [[ "$IN_RANGE" == true ]]; then
        if [[ "$SHORT_SHA" == "$FIRST_BAD" ]]; then
          echo "$SHORT_SHA $MESSAGE ◄── $RUN_INFO [HEAD/SUSPECT]"
        else
          echo "$SHORT_SHA $MESSAGE ◄── $RUN_INFO [SUSPECT]"
        fi
      else
        echo "$SHORT_SHA $MESSAGE ◄── $RUN_INFO"
      fi
    else
      if [[ "$IN_RANGE" == true ]]; then
        echo "$SHORT_SHA $MESSAGE [SUSPECT]"
      else
        echo "$SHORT_SHA $MESSAGE"
      fi
    fi
  done < <(echo "$GIT_LOG")

} > "$OUTPUT_FILE"

echo "Results written to: $OUTPUT_FILE"
echo ""
echo "Summary:"
echo "- Total commits analyzed: $(echo "$GIT_LOG" | wc -l)"
echo "- Commits with CI runs: ${#COMMIT_RUNS[@]}"
echo "- Suspect range size: $(if [[ -n "$LAST_GOOD" && -n "$FIRST_BAD" ]]; then git rev-list --count "$LAST_GOOD..$FIRST_BAD"; else echo "0"; fi) commits"
