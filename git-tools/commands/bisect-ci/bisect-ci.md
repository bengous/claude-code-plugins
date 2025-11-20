---
description: Bisect GitHub Actions CI runs to identify suspect commit ranges
argument-hint: [--branch <branch>] [--output <file>] [--limit <num>]
allowed-tools: Bash(gh:*), Bash(git:*), Bash(jq:*), Bash(mkdir:*), Write
tags: [git, debugging, ci]
---

# GitHub Actions CI Bisector

Maps GitHub Actions CI runs to git commits and identifies suspect ranges between last known good and first known bad commits.

## Usage

```bash
/bisect-ci
/bisect-ci --branch feature/my-branch
/bisect-ci --branch main --output debug/results.txt
/bisect-ci --limit 50
```

## Parameters

- `--branch <name>` - Branch to analyze (default: current branch)
- `--output <file>` - Output file path (default: temp/ci-bisect-TIMESTAMP.txt)
- `--limit <num>` - Number of CI runs to fetch (default: 100)

## What it does

1. Queries GitHub Actions "CI" workflow runs for the specified branch
2. Excludes validator package CI runs
3. Maps runs (SUCCESS/FAILURE/CANCELLED) to git log commits
4. Identifies suspect range: commits between last SUCCESS and first FAILURE
5. Outputs formatted results with clickable links to a file

## Output Format

```
╔═══════════════════════════════════════════════════════════════
║ SUSPECT RANGE START (HEAD) - Bug still present
╚═══════════════════════════════════════════════════════════════
abc1234 commit message ◄── FAILURE https://github.com/.../runs/123 [HEAD/SUSPECT]
...
[All commits in suspect range marked with [SUSPECT]]
...
╔═══════════════════════════════════════════════════════════════
║ SUSPECT RANGE END - Bug introduced somewhere between here and HEAD
╚═══════════════════════════════════════════════════════════════
xyz9876 commit message ◄── SUCCESS https://github.com/.../runs/456 [LAST KNOWN GOOD]
```

---

Execute the bisect-ci script with arguments: $ARGUMENTS
