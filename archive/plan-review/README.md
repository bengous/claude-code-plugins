# plan-review (archived)

Whole plugin, retired from the marketplace. It gated `ExitPlanMode` behind a multi-agent
review that the repo never adopted, and it held the last live Python file in the tree.

## Contents

```
.claude-plugin/plugin.json      # manifest, v1.1.0 at archival
agents/
  architect-reviewer.md         # Opus reviewer, one of the two round-1 agents
commands/
  setup-plan-review.md          # /plan-review:setup-plan-review wrapper
hooks/
  preuse-exitplanmode.py        # PreToolUse:ExitPlanMode gate (217 lines)
scripts/
  package.json                  # {"type": "commonjs"} marker, the repo is ESM
  setup-plan-review.js          # writes the hook into .claude/settings.local.json
WORKFLOW.md                     # three-round review diagram
```

The plugin shipped only one of the two reviewers it describes. `WORKFLOW.md` pairs the
architect with a "Code Simplifier" agent, and no such agent is defined here or anywhere else
in the repo.

## Why archived

**Superseded by an in-repo hook, itself later retired.** At archival, `.claude/hooks/plan-reference-audit.ts`
became the live `ExitPlanMode` gate. It spawned the `plan-reference-auditor` agent to check a plan's
file paths and symbols against the real codebase, denied only on a reference that provably did not
exist, and failed open on any spawn or parse error. The Python hook asked a different question: it
globbed `.claude/plans/*.md`, took the most recently modified file, and demanded a `## Plan Review
Status` section reading `APPROVED` before it would let the plan through. Two gates on one tool call
is one too many, and the TypeScript one covered the real usage. That hook and its agent were removed
from the repo on 2026-08-23; nothing gates `ExitPlanMode` today.

**Last Python in the tree.** The repo standardises on TypeScript and shell. Retiring this
plugin removes `preuse-exitplanmode.py`, the only remaining `.py` file outside `archive/` and
`_docs/`.

**Orphan installer.** `scripts/setup-plan-review.js` was written as a copy of
`orchestration/scripts/setup-hooks.js`. That original was deleted earlier, and commit
`fb8067e` stripped the dangling pointer to it out of this file's header. What was left is a
CommonJS installer for a hook nobody installs, needing its own `package.json` type marker to
survive the repo going ESM.

## Consumers updated at archival

- `.claude-plugin/marketplace.json` — the `plan-review` entry was removed.
- `README.md` — the `plan-review` row was removed from the plugin table.
