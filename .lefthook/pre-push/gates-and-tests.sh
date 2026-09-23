#!/usr/bin/env bash
#
# lefthook pre-push: on a push to main, the version guard over the pushed
# commits; on a push to dev, the e2e gate over the pushed commit; then every CI
# gate and both test runs, on the working tree.
#
# A push from a linked worktree exports GIT_DIR to this hook. The test suites
# run git in temp repos with the inherited environment: with GIT_DIR still set,
# their commits would land in the pushing repo.

set -euo pipefail

# Git passes one line per ref: <local ref> <local oid> <remote ref> <remote oid>.
# A deletion carries the null oid as its local oid and pushes no code to check.
pushed_refs="$(cat)"
if [[ -n "${pushed_refs}" ]] && ! grep -qvE '^[^ ]+ 0+ ' <<<"${pushed_refs}"; then
  echo "pre-push: deletions only, gates skipped"
  exit 0
fi

git_env_list="$(git rev-parse --local-env-vars)"
mapfile -t git_env_vars <<<"${git_env_list}"
unset "${git_env_vars[@]}"

bun ./scripts/check-plugin-bumps.ts --pre-push <<<"${pushed_refs}"
bun ./scripts/check-e2e-green.ts <<<"${pushed_refs}"
bun ./scripts/run-gates.ts

# `bun test` skips dot directories, so the repo's own hooks need their own run.
bun test
bun test ./.claude/hooks/*.test.ts
