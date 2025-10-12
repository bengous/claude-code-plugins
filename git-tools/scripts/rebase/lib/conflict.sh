#!/usr/bin/env bash
# Conflict Handler for Interactive Rebase
# Provides conflict detection and resolution guidance

# Note: SCRIPT_DIR is set by the main rebase script
# and ui.sh is already sourced, so no need to source again

# Detect if rebase is in conflict state
detect_conflict() {
  if [[ -d ".git/rebase-merge" ]] || [[ -d ".git/rebase-apply" ]]; then
    return 0
  fi
  return 1
}

# Get conflicted files
get_conflicted_files() {
  git diff --name-only --diff-filter=U
}

# Display conflict guidance
display_conflict_guidance() {
  display_banner "Conflict Detected"

  echo -e "${YELLOW}The rebase has encountered conflicts that need manual resolution.${NC}"
  echo

  local conflicted_files=$(get_conflicted_files)

  if [[ -z "$conflicted_files" ]]; then
    echo -e "${GRAY}No conflicted files found. The rebase may have already been resolved.${NC}"
    echo
    return
  fi

  echo -e "${CYAN}Conflicted files:${NC}"
  while IFS= read -r file; do
    local conflict_count=$(grep -c "^<<<<<<< " "$file" 2>/dev/null || echo "0")
    echo -e "  ${RED}✗${NC} ${file} ${GRAY}(${conflict_count} conflicts)${NC}"
  done <<< "$conflicted_files"
  echo

  echo -e "${CYAN}Resolution steps:${NC}"
  echo -e "  ${GREEN}1.${NC} Open conflicted files and resolve conflicts"
  echo -e "  ${GREEN}2.${NC} Look for conflict markers:"
  echo -e "     ${GRAY}<<<<<<< HEAD${NC}          (current changes)"
  echo -e "     ${GRAY}=======${NC}               (separator)"
  echo -e "     ${GRAY}>>>>>>> commit${NC}        (incoming changes)"
  echo -e "  ${GREEN}3.${NC} Edit files to keep desired changes"
  echo -e "  ${GREEN}4.${NC} Remove conflict markers"
  echo -e "  ${GREEN}5.${NC} Stage resolved files:"
  echo -e "     ${BLUE}git add <file>${NC}"
  echo -e "  ${GREEN}6.${NC} Continue rebase:"
  echo -e "     ${BLUE}/rebase:continue${NC}"
  echo

  echo -e "${GRAY}Alternative actions:${NC}"
  echo -e "  ${YELLOW}Skip this commit:${NC}   ${BLUE}/rebase:skip${NC}"
  echo -e "  ${RED}Abort rebase:${NC}      ${BLUE}/rebase:abort${NC}"
  echo

  # Show a preview of first conflict
  local first_file=$(echo "$conflicted_files" | head -1)
  if [[ -n "$first_file" ]]; then
    echo -e "${CYAN}Preview of conflicts in ${first_file}:${NC}"
    echo -e "${GRAY}───────────────────────────────────────────────────${NC}"
    grep -B2 -A2 "^<<<<<<< " "$first_file" 2>/dev/null | head -15 || echo "Unable to preview"
    echo -e "${GRAY}───────────────────────────────────────────────────${NC}"
    echo
  fi
}

# Analyze conflicts and provide smart suggestions
analyze_conflicts() {
  local file="$1"

  if [[ ! -f "$file" ]]; then
    echo -e "${RED}File not found: $file${NC}" >&2
    return 1
  fi

  local conflict_count=$(grep -c "^<<<<<<< " "$file" 2>/dev/null || echo "0")

  if [[ "$conflict_count" -eq 0 ]]; then
    echo -e "${GREEN}No conflicts in $file${NC}"
    return 0
  fi

  display_banner "Conflict Analysis: $file"

  echo -e "${YELLOW}Found ${conflict_count} conflict(s)${NC}"
  echo

  local conflict_num=1
  local in_conflict=false
  local current_section=""
  local line_num=0

  while IFS= read -r line; do
    ((line_num++))

    if [[ "$line" =~ ^'<<<<<<<' ]]; then
      in_conflict=true
      current_section="ours"
      echo -e "${CYAN}Conflict #${conflict_num} at line ${line_num}:${NC}"
      echo -e "${GRAY}───────────────────────────────────────────────────${NC}"
      echo -e "${GREEN}Your changes (HEAD):${NC}"
      ((conflict_num++))
    elif [[ "$line" =~ ^'======='$ ]] && [[ "$in_conflict" == true ]]; then
      current_section="theirs"
      echo -e "${BLUE}Incoming changes:${NC}"
    elif [[ "$line" =~ ^'>>>>>>>' ]] && [[ "$in_conflict" == true ]]; then
      in_conflict=false
      current_section=""
      echo -e "${GRAY}───────────────────────────────────────────────────${NC}"
      echo
    elif [[ "$in_conflict" == true ]]; then
      if [[ "$current_section" == "ours" ]]; then
        echo -e "${GREEN}  $line${NC}"
      elif [[ "$current_section" == "theirs" ]]; then
        echo -e "${BLUE}  $line${NC}"
      fi
    fi
  done < "$file"
}

# Validate that conflicts are resolved
validate_resolution() {
  local conflicted_files=$(get_conflicted_files)

  if [[ -n "$conflicted_files" ]]; then
    echo -e "${RED}Error: Conflicts still exist in the following files:${NC}" >&2
    while IFS= read -r file; do
      echo -e "  ${RED}✗${NC} ${file}" >&2
    done <<< "$conflicted_files"
    echo
    echo -e "${YELLOW}Please resolve all conflicts and stage the files before continuing.${NC}" >&2
    return 1
  fi

  # Check for conflict markers in staged files
  local staged_files=$(git diff --cached --name-only)

  if [[ -n "$staged_files" ]]; then
    while IFS= read -r file; do
      if grep -q "^<<<<<<< " "$file" 2>/dev/null; then
        echo -e "${RED}Error: Conflict markers still present in staged file: ${file}${NC}" >&2
        echo -e "${YELLOW}Please remove conflict markers before continuing.${NC}" >&2
        return 1
      fi
    done <<< "$staged_files"
  fi

  return 0
}

# Show rebase status
display_rebase_status() {
  if ! detect_conflict; then
    echo -e "${GREEN}No active rebase${NC}"
    return 1
  fi

  display_banner "Rebase Status"

  if [[ -f ".git/rebase-merge/msgnum" ]] && [[ -f ".git/rebase-merge/end" ]]; then
    local current=$(cat .git/rebase-merge/msgnum)
    local total=$(cat .git/rebase-merge/end)
    local remaining=$((total - current))

    echo -e "${CYAN}Progress:${NC} Commit ${current} of ${total}"
    echo -e "${GRAY}Remaining: ${remaining} commits${NC}"
    echo
  fi

  local conflicted_files=$(get_conflicted_files)

  if [[ -n "$conflicted_files" ]]; then
    echo -e "${YELLOW}Conflicted files:${NC}"
    while IFS= read -r file; do
      echo -e "  ${RED}✗${NC} ${file}"
    done <<< "$conflicted_files"
  else
    echo -e "${GREEN}No conflicted files${NC}"
  fi

  echo
}
