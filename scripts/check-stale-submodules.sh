#!/usr/bin/env bash
# Check if submodules are behind upstream and print a reminder.
# Non-blocking: always exits 0.
set -euo pipefail

git submodule foreach --quiet 'git fetch origin --quiet' 2>/dev/null || true

stale=0
# shellcheck disable=SC2016
while IFS= read -r sub; do
  local_sha="$(git -C "$sub" rev-parse HEAD 2>/dev/null)" || continue
  remote_sha="$(git -C "$sub" rev-parse origin/HEAD 2>/dev/null)" ||
    remote_sha="$(git -C "$sub" rev-parse origin/main 2>/dev/null)" || continue

  if [[ "$local_sha" != "$remote_sha" ]]; then
    behind="$(git -C "$sub" rev-list --count "$local_sha..$remote_sha")"
    printf "  %s is %s commits behind upstream\n" "$sub" "$behind"
    stale=1
  fi
done < <(git submodule foreach --quiet 'echo $sm_path')

if [[ "$stale" -eq 1 ]]; then
  printf "\nRun: scripts/update-submodules.sh\n"
fi

exit 0
