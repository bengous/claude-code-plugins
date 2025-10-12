#!/usr/bin/env bash
# UI Helper Functions for Interactive Rebase
# Provides colored output, formatted tables, and visual rebase plans

# Color codes (matching issue script pattern)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m'

# Display a styled banner
display_banner() {
  local title="$1"
  echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${CYAN}  ${title}${NC}"
  echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
  echo
}

# Display commits table
display_commits_table() {
  local base="$1"

  display_banner "Commits to Rebase"

  echo -e "${GRAY}Base: $(git rev-parse --short "$base")${NC}"
  echo

  local idx=1
  while IFS='|' read -r hash subject author date; do
    local short_hash=$(git rev-parse --short "$hash")
    echo -e "${GRAY}[$idx]${NC} ${YELLOW}${short_hash}${NC} ${subject}"
    echo -e "     ${GRAY}by ${author} on ${date}${NC}"
    ((idx++))
  done < <(git log --reverse --format="%H|%s|%an|%ar" "${base}..HEAD")

  echo
}

# Prompt for action on a single commit
prompt_commit_action() {
  local idx="$1"
  local hash="$2"
  local subject="$3"

  local short_hash=$(git rev-parse --short "$hash")

  echo -e "${CYAN}Commit ${idx}:${NC} ${YELLOW}${short_hash}${NC} ${subject}"
  echo -n "Action [p/s/r/d/?] (pick/squash/reword/drop/help): "
  read -r action

  case "$action" in
    "?"|help)
      echo -e "${GRAY}Actions:${NC}"
      echo -e "  ${GREEN}p${NC} or ${GREEN}pick${NC}   - Keep commit as-is"
      echo -e "  ${BLUE}s${NC} or ${BLUE}squash${NC} - Combine with previous commit"
      echo -e "  ${CYAN}r${NC} or ${CYAN}reword${NC} - Change commit message (AI suggestions)"
      echo -e "  ${RED}d${NC} or ${RED}drop${NC}   - Remove commit"
      echo
      prompt_commit_action "$idx" "$hash" "$subject"
      return
      ;;
    p|pick|"")
      echo "pick"
      ;;
    s|squash)
      if [[ "$idx" -eq 1 ]]; then
        echo -e "${RED}Error: Cannot squash first commit${NC}" >&2
        prompt_commit_action "$idx" "$hash" "$subject"
        return
      fi
      echo "squash"
      ;;
    r|reword)
      echo "reword"
      ;;
    d|drop)
      echo "drop"
      ;;
    *)
      echo -e "${RED}Invalid action. Using 'pick'${NC}" >&2
      echo "pick"
      ;;
  esac
}

# Display visual rebase plan
display_rebase_plan() {
  local base="$1"
  shift
  local -a commits=("$@")

  display_banner "Rebase Plan"

  echo -e "${GRAY}Base: $(git rev-parse --short "$base")${NC}"
  echo

  local idx=1
  local pick_count=0
  local squash_count=0
  local reword_count=0
  local drop_count=0

  for commit_data in "${commits[@]}"; do
    IFS='|' read -r hash action new_message <<< "$commit_data"
    local short_hash=$(git rev-parse --short "$hash")
    local subject=$(git log -1 --format=%s "$hash")

    case "$action" in
      pick)
        echo -e "${GREEN}✓ PICK  ${NC} ${YELLOW}${short_hash}${NC} ${subject}"
        ((pick_count++))
        ;;
      squash)
        echo -e "${BLUE}⬆ SQUASH${NC} ${YELLOW}${short_hash}${NC} ${subject}"
        echo -e "         ${GRAY}└─> Will combine with previous commit${NC}"
        ((squash_count++))
        ;;
      reword)
        echo -e "${CYAN}✎ REWORD${NC} ${YELLOW}${short_hash}${NC} ${subject}"
        if [[ -n "$new_message" ]]; then
          echo -e "         ${GRAY}└─> New: ${new_message}${NC}"
        fi
        ((reword_count++))
        ;;
      drop)
        echo -e "${RED}✗ DROP  ${NC} ${YELLOW}${short_hash}${NC} ${GRAY}${subject}${NC}"
        ((drop_count++))
        ;;
    esac

    ((idx++))
  done

  echo
  echo -e "${GRAY}Summary: ${pick_count} pick, ${squash_count} squash, ${reword_count} reword, ${drop_count} drop${NC}"
  echo
}

# Confirm rebase plan
confirm_plan() {
  echo -n "Proceed with rebase? [Y/n]: "
  read -r confirm

  case "$confirm" in
    n|N|no|No|NO)
      echo -e "${YELLOW}Rebase cancelled${NC}"
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

# Display success message
display_success() {
  local message="$1"
  echo
  echo -e "${GREEN}✓ ${message}${NC}"
  echo
}

# Display error message
display_error() {
  local message="$1"
  echo
  echo -e "${RED}✗ Error: ${message}${NC}"
  echo
}

# Display warning message
display_warning() {
  local message="$1"
  echo
  echo -e "${YELLOW}⚠ Warning: ${message}${NC}"
  echo
}
