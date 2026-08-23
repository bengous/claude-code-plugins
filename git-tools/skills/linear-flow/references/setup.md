# Linear Flow: Repo Setup

Bootstrap order matters: sync branches first, rulesets second, otherwise the linear-history rule can reject the sync push.

Confirm with the user before step 2: it changes live GitHub config.

## 1. Initial sync

If `dev` does not exist, create it from `main` and push. If both exist and `main` holds commits `dev` lacks (old merge commits), fast-forward or merge `main` into `dev` one last time so `main` becomes an ancestor of `dev`. Verify:

```bash
git merge-base --is-ancestor origin/main origin/dev && echo ok
```

If they truly diverged, stop and resolve with the user before touching rulesets.

## 2. Rulesets

Replace `OWNER/REPO`. Rulesets require admin on the repo.

```bash
gh api -X POST repos/OWNER/REPO/rulesets --input - <<'EOF'
{
  "name": "Protect main branch",
  "target": "branch",
  "enforcement": "active",
  "conditions": {"ref_name": {"include": ["refs/heads/main"], "exclude": []}},
  "rules": [
    {"type": "non_fast_forward"},
    {"type": "deletion"},
    {"type": "required_linear_history"}
  ],
  "bypass_actors": []
}
EOF

gh api -X POST repos/OWNER/REPO/rulesets --input - <<'EOF'
{
  "name": "Linear history on dev",
  "target": "branch",
  "enforcement": "active",
  "conditions": {"ref_name": {"include": ["refs/heads/dev"], "exclude": []}},
  "rules": [
    {"type": "required_linear_history"},
    {"type": "deletion"}
  ],
  "bypass_actors": []
}
EOF
```

Signed commits, if the user wants them (recommended when the flow relies on local rebase keeping author signatures):

```bash
gh api -X POST repos/OWNER/REPO/rulesets --input - <<'EOF'
{
  "name": "Require signed commits",
  "target": "branch",
  "enforcement": "active",
  "conditions": {"ref_name": {"include": ["~ALL"], "exclude": []}},
  "rules": [{"type": "required_signatures"}],
  "bypass_actors": [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}]
}
EOF
```

If an existing ruleset carries a `pull_request` rule on `main`, remove that rule (`gh api -X PUT .../rulesets/<id>` with the full object): the release push is not a PR merge.

## 3. CI guard

Add to the repo's CI workflow, triggered on `push` to both branches (checkout needs `fetch-depth: 0`):

```yaml
      # main is a delayed fast-forward pointer on dev's history: releases move it
      # with `git push origin dev:main`. Fail loudly if main ever leaves that line.
      - name: Guard main as a strict prefix of dev
        run: |
          git fetch --no-tags origin \
            +refs/heads/main:refs/remotes/origin/main \
            +refs/heads/dev:refs/remotes/origin/dev
          if ! git merge-base --is-ancestor origin/main origin/dev; then
            echo "::error::main is not an ancestor of dev — main must stay a fast-forward prefix of dev."
            exit 1
          fi
          echo "main is an ancestor of dev: $(git rev-parse origin/main)"
```

Keep `main` in the CI `push` trigger list: a ref update reaching it outside the release path must still get validated.

## 4. Repo CLAUDE.md

Add a Branching section stating, in the repo's own words: the two branch roles, the threshold rule, landing (`git push origin <branch>:dev`, never the merge button), release (`git push origin dev:main`), and where the review layers sit. Keep it under 10 lines; the doctrine lives in this skill.

## 5. Verify

```bash
gh api repos/OWNER/REPO/rulesets --jq '.[] | {name, enforcement}'
git commit --allow-empty -m "test: ruleset probe" && git push origin dev && git push origin dev:main
```

Both pushes must pass; then drop the probe with a revert or leave it out by testing on real work instead. Delete merged and stale branches so only `dev` and `main` remain.
