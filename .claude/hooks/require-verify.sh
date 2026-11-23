#!/usr/bin/env bash
# One script behind two hooks of .claude/settings.json, which act in a cloud session alone:
#   require-verify.sh record   PostToolUse on the Skill tool: when the verify skill ran, records the working tree
#   require-verify.sh stop     Stop: sends the session back to verify while the tree differs from that record,
#                              twice in a row at most
set -uo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = true ] || exit 0

input=$(cat)
root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root" || exit 0
state=$(git rev-parse --absolute-git-dir 2>/dev/null)/factory-verify || exit 0
mkdir -p "$state" || exit 0

# The tree object of everything in the working tree that git does not ignore. A commit leaves it as it was, so a
# session that verified, then committed and pushed, is not sent back.
tree_now() {
  local scratch tree
  scratch=$(mktemp -d) || return 1
  cp "$(git rev-parse --git-path index)" "$scratch/index" 2>/dev/null
  tree=$(GIT_INDEX_FILE=$scratch/index git add -A . >/dev/null 2>&1 && GIT_INDEX_FILE=$scratch/index git write-tree 2>/dev/null)
  rm -rf "$scratch"
  [ -n "$tree" ] && printf '%s\n' "$tree"
}

case "${1:-}" in
  record)
    skill=$(jq -r '.tool_input.skill // empty' <<<"$input" 2>/dev/null)
    [ "$skill" = verify ] || exit 0
    tree=$(tree_now) || exit 0
    printf '%s\n' "$tree" >"$state/tree"
    rm -f "$state/sent"
    ;;
  stop)
    tree=$(tree_now) || exit 0
    # A session that changed nothing since it left dev has nothing to verify: one that stops as blocked, or
    # only reads. Where that base cannot be found, the tree counts as changed.
    if base=$(git merge-base HEAD "origin/dev" 2>/dev/null); then
      [ "$tree" = "$(git rev-parse "$base^{tree}" 2>/dev/null)" ] && exit 0
    fi
    if [ "$tree" = "$(cat "$state/tree" 2>/dev/null)" ]; then
      rm -f "$state/sent"
      exit 0
    fi
    sent=$(cat "$state/sent" 2>/dev/null)
    if [ "${sent:-0}" -ge 2 ]; then
      rm -f "$state/sent"
      exit 0
    fi
    echo $((${sent:-0} + 1)) >"$state/sent"
    echo "The working tree changed since the verify skill last ran. Run the verify skill again, then state under Checks in the pull request body the command it ran and its result." >&2
    exit 2
    ;;
  *)
    echo "usage: require-verify.sh record|stop" >&2
    exit 1
    ;;
esac
