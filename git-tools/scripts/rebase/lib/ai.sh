#!/usr/bin/env bash
# AI Helper Functions for Intelligent Rebase
# Provides reword suggestions and smart squash messages

# Note: SCRIPT_DIR is set by the main rebase script
# and ui.sh is already sourced, so no need to source again

# Suggest reword options for a commit
suggest_reword() {
  local hash="$1"
  local original_message=$(git log -1 --format=%s "$hash")
  local body=$(git log -1 --format=%b "$hash")
  local files_changed=$(git diff-tree --no-commit-id --name-only -r "$hash" | wc -l)
  local insertions=$(git show --stat "$hash" | tail -1 | grep -oP '\d+(?= insertion)' || echo "0")
  local deletions=$(git show --stat "$hash" | tail -1 | grep -oP '\d+(?= deletion)' || echo "0")
  local improved_message=""
  local guessed_type="feat"

  display_banner "AI Reword Suggestions"

  echo -e "${GRAY}Original:${NC} $original_message"
  if [[ -n "$body" ]]; then
    echo -e "${GRAY}Body:${NC}"
    echo "$body" | head -3
    if [[ $(echo "$body" | wc -l) -gt 3 ]]; then
      echo -e "${GRAY}... (truncated)${NC}"
    fi
  fi
  echo -e "${GRAY}Stats: ${files_changed} files, +${insertions}/-${deletions} lines${NC}"
  echo

  # Parse conventional commit type
  local conv_type=""
  if [[ "$original_message" =~ ^(feat|fix|docs|style|refactor|test|chore|perf|ci|build|revert)(\(.*\))?: ]]; then
    conv_type="${BASH_REMATCH[1]}"
  fi

  # Generate AI suggestions (mock for now - can be enhanced with actual Claude API)
  echo -e "${GREEN}[1]${NC} Keep original"
  echo -e "    ${GRAY}${original_message}${NC}"
  echo

  # Suggestion 2: Improve conventional commit
  if [[ -n "$conv_type" ]]; then
    local improved_message=$(echo "$original_message" | sed 's/^\([a-z]*\): /\1: /' | sed 's/\.$//')
    echo -e "${GREEN}[2]${NC} Improve conventional commit format"
    echo -e "    ${GRAY}${improved_message}${NC}"
  else
    # Suggest adding conventional commit prefix
    local guessed_type="feat"
    if [[ "$original_message" =~ fix|bug|error ]]; then
      guessed_type="fix"
    elif [[ "$original_message" =~ doc|readme ]]; then
      guessed_type="docs"
    elif [[ "$original_message" =~ refactor|cleanup|clean ]]; then
      guessed_type="refactor"
    elif [[ "$original_message" =~ test ]]; then
      guessed_type="test"
    fi
    echo -e "${GREEN}[2]${NC} Add conventional commit prefix"
    echo -e "    ${GRAY}${guessed_type}: ${original_message}${NC}"
  fi
  echo

  # Suggestion 3: More concise
  local concise_message=$(echo "$original_message" | sed 's/^\([a-z]*\): /\1: /' | cut -c1-50)
  echo -e "${GREEN}[3]${NC} More concise (<=50 chars)"
  echo -e "    ${GRAY}${concise_message}${NC}"
  echo

  echo -e "${GREEN}[4]${NC} Custom message"
  echo

  echo -n "Choose [1-4]: "
  read -r choice

  case "$choice" in
    1|"")
      echo "$original_message"
      ;;
    2)
      if [[ -n "$conv_type" ]]; then
        echo "$improved_message"
      else
        echo "${guessed_type}: ${original_message}"
      fi
      ;;
    3)
      echo "$concise_message"
      ;;
    4)
      echo -n "Enter new message: "
      read -r custom
      echo "$custom"
      ;;
    *)
      echo "$original_message"
      ;;
  esac
}

# Parse conventional commit
parse_conventional_commit() {
  local message="$1"
  local pattern='^(feat|fix|docs|style|refactor|test|chore|perf|ci|build|revert)(\(([^)]+)\))?(!)?: '

  if [[ "$message" =~ $pattern ]]; then
    local type="${BASH_REMATCH[1]}"
    local scope="${BASH_REMATCH[3]}"
    local breaking="${BASH_REMATCH[4]}"
    local subject="${message#*: }"

    echo "$type|$scope|$breaking|$subject"
  else
    echo "none|||$message"
  fi
}

# Generate smart squash message from multiple commits
generate_squash_message() {
  local -a commits=("$@")

  if [[ ${#commits[@]} -eq 0 ]]; then
    echo "combined changes"
    return
  fi

  # Collect commit types
  declare -A type_counts
  local messages=()

  for hash in "${commits[@]}"; do
    local msg=$(git log -1 --format=%s "$hash")
    messages+=("$msg")

    IFS='|' read -r type scope breaking subject <<< "$(parse_conventional_commit "$msg")"
    if [[ "$type" != "none" ]]; then
      ((type_counts[$type]++))
    fi
  done

  # Find most common type
  local primary_type="feat"
  local max_count=0
  for type in "${!type_counts[@]}"; do
    if [[ ${type_counts[$type]} -gt $max_count ]]; then
      max_count=${type_counts[$type]}
      primary_type="$type"
    fi
  done

  # Check if all commits have the same scope
  local common_scope=""
  local first_scope=""
  local scope_consistent=true

  for msg in "${messages[@]}"; do
    IFS='|' read -r type scope breaking subject <<< "$(parse_conventional_commit "$msg")"
    if [[ -z "$first_scope" ]]; then
      first_scope="$scope"
      common_scope="$scope"
    elif [[ "$scope" != "$first_scope" ]]; then
      scope_consistent=false
      break
    fi
  done

  # Build squash message
  local squash_msg="${primary_type}"
  if [[ "$scope_consistent" == "true" && -n "$common_scope" ]]; then
    squash_msg="${squash_msg}(${common_scope})"
  fi

  # Generate descriptive subject
  if [[ ${#commits[@]} -eq 2 ]]; then
    # For 2 commits, try to combine subjects
    local subj1 subj2
    IFS='|' read -r _ _ _ subj1 <<< "$(parse_conventional_commit "${messages[0]}")"
    IFS='|' read -r _ _ _ subj2 <<< "$(parse_conventional_commit "${messages[1]}")"
    squash_msg="${squash_msg}: ${subj1} and ${subj2}"
  else
    # For 3+ commits, use generic message
    squash_msg="${squash_msg}: combined changes from ${#commits[@]} commits"
  fi

  echo "$squash_msg"
}

# Show AI-powered squash preview
preview_squash() {
  local prev_hash="$1"
  local curr_hash="$2"

  echo
  echo -e "${CYAN}Squash Preview:${NC}"
  echo

  local prev_msg=$(git log -1 --format=%s "$prev_hash")
  local curr_msg=$(git log -1 --format=%s "$curr_hash")

  echo -e "${GRAY}Previous: ${prev_msg}${NC}"
  echo -e "${GRAY}Current:  ${curr_msg}${NC}"
  echo

  local squash_msg=$(generate_squash_message "$prev_hash" "$curr_hash")
  echo -e "${GREEN}Combined: ${squash_msg}${NC}"
  echo
}
