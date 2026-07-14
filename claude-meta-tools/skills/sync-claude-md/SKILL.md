---
name: sync-claude-md
description: Synchronizes project CLAUDE.md with recent codebase changes by analyzing git history, reviewing against official Anthropic best practices with parallel agents, and proposing updates for user approval. Use when CLAUDE.md is outdated, missing, or drifted after major architectural changes.
license: Complete terms in LICENSE.txt
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - WebFetch
  - Agent
  - AskUserQuestion
  - Glob
  - Grep
---

# Sync CLAUDE.md

Keeps project-level CLAUDE.md synchronized with codebase evolution. Never commits — the user commits manually.

Locate the file: check `./CLAUDE.md` (preferred), then `./.claude/CLAUDE.md`. If both exist, warn about the duplicate, recommend consolidating to `./CLAUDE.md`, and ask which to update. File exists → Update workflow. Missing → Create workflow.

## Update workflow

### 1. Gather change context

Use the path located above (not a hardcoded `CLAUDE.md`):

```bash
path=<located path, e.g. ./CLAUDE.md>
last=$(git log --follow --format="%H" -1 -- "$path")
git rev-list --count "$last"..HEAD
git log --oneline "$last"..HEAD
```

Identify major changes: library migrations, new tools or commands, architecture shifts. If more than 10 commits, use heavy analysis: for complex change areas, delegate to a subagent via the Agent tool (e.g. "Analyze the X migration in commits A..B and summarize what CLAUDE.md changes it requires") and keep only the summary. For 10 or fewer, read the commits directly (`git show --stat` on key ones).

### 2. Parallel best-practices review

Spawn 3 review agents (model: sonnet) in a single message so they run concurrently, each with the same prompt:

```
Review the project CLAUDE.md at <path> against official Anthropic best
practices. Read https://code.claude.com/docs/en/memory.md before reviewing.
Report:
1. What aligns with best practices
2. What's missing or incorrect
3. Specific recommendations
Focus: technical guidance (commands, code style, testing), documented
architecture, conciseness, official structure.
```

Fetch the official docs yourself as well:

```
WebFetch("https://code.claude.com/docs/en/memory.md",
  "Extract CLAUDE.md structure, content, and best-practice guidance")
```

Degraded modes — always mention them in the final report:
- 1 agent fails → continue with 2 reports
- 2+ agents fail → skip parallel review, review directly yourself
- Docs unreachable after one retry → use built-in knowledge, flag that official docs weren't consulted

### 3. Proposal

Cross-reference the agent reports (weight consensus), official docs, and commit context. Draft a proposal: summary, then sections to add / modify / remove, each with exact content and a one-line rationale. Preserve existing good content; never remove anything whose purpose you don't understand.

### 4. Approval and apply

Present the full proposal, then use AskUserQuestion to confirm (apply / reject). On approval: apply with Edit (Write only for a full rewrite), summarize what changed, remind the user to review and commit. On rejection: offer to save the proposal to a file for later.

## Create workflow

If not in a git repo (`git rev-parse --is-inside-work-tree`), tell the user CLAUDE.md is most useful in version-controlled projects and ask whether to proceed.

1. Detect the stack from project files: `package.json`, `tsconfig.json`, `Cargo.toml`, `pyproject.toml` / `requirements.txt`, `.github/workflows/`, `docker-compose.yml`. Note test framework, linter/formatter, build tooling, architecture layout.
2. Fetch the official docs (same WebFetch as above).
3. Use AskUserQuestion: minimal starter template, or comprehensive CLAUDE.md from full project analysis.
4. Generate the file with concrete commands and patterns actually found in the project — no generic filler.
5. Show the complete content and get approval before writing `./CLAUDE.md`. On rejection, offer to save the draft elsewhere.
