#!/usr/bin/env bash
# Update submodules to latest upstream and commit (GPG-signed).
# Usage: scripts/update-submodules.sh
set -euo pipefail

repo_root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$repo_root"

# Ensure submodules are initialized
git submodule update --init --recursive --quiet

# Fetch upstream for all submodules
printf "Fetching upstream for all submodules...\n"
git submodule foreach --quiet 'git fetch origin --quiet'

# Check each submodule for new commits
changed=0
# shellcheck disable=SC2016
while IFS= read -r sub; do
  local_sha="$(git -C "$sub" rev-parse HEAD)"
  # Try origin/HEAD first (follows default branch), fall back to origin/main
  if ! remote_sha="$(git -C "$sub" rev-parse origin/HEAD 2>/dev/null)"; then
    remote_sha="$(git -C "$sub" rev-parse origin/main)"
  fi

  if [[ "$local_sha" != "$remote_sha" ]]; then
    ahead="$(git -C "$sub" rev-list --count "$local_sha..$remote_sha")"
    printf "=== %s (%s commits behind) ===\n" "$sub" "$ahead"
    git -C "$sub" log --oneline "${local_sha}..${remote_sha}" | head -20
    printf "\n"
    changed=1
  fi
done < <(git submodule foreach --quiet 'echo $sm_path')

if [[ "$changed" -eq 0 ]]; then
  printf "All submodules are up to date.\n"
  exit 0
fi

read -rp "Update submodules? [y/N] " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  printf "Aborted.\n"
  exit 0
fi

git submodule update --remote --merge
git add .external/
git commit -m "chore: update submodules to latest"
printf "Done. Submodules updated and committed.\n"
