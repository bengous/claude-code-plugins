---
name: sync-claude-md
description: Synchronizes project CLAUDE.md with recent codebase changes by analyzing git history since the file last changed and proposing commit-motivated updates for user approval. Use when CLAUDE.md is outdated or drifted after major architectural changes. For instruction-budget, anti-pattern, or stale-reference audits of the file itself, use context-audit.
license: Complete terms in LICENSE.txt
allowed-tools:
  - Bash(git:*)
  - Read
  - Write
  - Edit
  - Agent
  - AskUserQuestion
  - Glob
  - Grep
---

# Sync CLAUDE.md

Keeps project-level CLAUDE.md synchronized with codebase evolution. Never commits — the user commits manually.

Preconditions:

- Not in a git repo (`git rev-parse --is-inside-work-tree` fails) → the analysis below is git history; without it this skill has nothing to work from. Point the user to `/init` and stop.
- Locate the file: check `./CLAUDE.md` (preferred), then `./.claude/CLAUDE.md`. If both exist, warn about the duplicate, recommend consolidating to `./CLAUDE.md`, and ask which to update. Missing → suggest `/init` to bootstrap one and stop.

## 1. Gather change context

Use the path located above (not a hardcoded `CLAUDE.md`):

```bash
path=<located path, e.g. ./CLAUDE.md>
last=$(git log --follow --format="%H" -1 -- "$path")
git rev-list --count "$last"..HEAD
git log --oneline "$last"..HEAD
```

Identify commits that contradict or outgrow what CLAUDE.md claims: library migrations, new tools or commands, architecture shifts. If more than 10 commits, delegate complex change areas to a subagent via the Agent tool; require its findings in the format `<sha> — <CLAUDE.md claim impacted>`, one line each, so the SHAs survive into the proposal. For 10 or fewer, read the commits directly (`git show --stat` on key ones).

Zero relevant commits since the last CLAUDE.md change → say so and stop. Do not pad an empty proposal.

## 2. Proposal

Draft a proposal: summary, then sections to add / modify / remove, each with exact content, a one-line rationale, and a `Motivated by: <sha>` (or `<A>..<B>`) line. Every SHA cited in a `Motivated by:` line (for a range, both endpoints) must appear in step 1's `git log` output. An item without a motivating commit is not proposed — general improvement of the file is context-audit's territory, not this skill's. Preserve existing good content; never remove anything whose purpose you don't understand.

## 3. Approval and apply

Present the full proposal, then use AskUserQuestion to confirm (apply / reject). On approval: apply with Edit (Write only for a full rewrite), summarize what changed, remind the user to review and commit. On rejection: offer to save the proposal to a file for later.
