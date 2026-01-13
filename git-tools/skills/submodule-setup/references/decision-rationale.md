# Decision Rationale: Why Git Submodules

## The Problem

Managing multiple branches in parallel creates friction:
- `main`/`dev`: Production code
- `docs-external`: External documentation
- `n8n-exports`: Exported workflow definitions

**The pain point:** When an agent working on `dev` needs to read documentation, it must switch branches, breaking context. This friction compounds as automation increases.

## Options Evaluated

| Approach | Verdict | Why |
|----------|---------|-----|
| **Git Subtree** | Rejected | Overlapping directory paths between branches broke merges. Subtree requires clean prefix separation. |
| **Sibling Repos + Symlinks** | Considered | Works, but requires manual setup script on every clone. No version tracking. |
| **Gitignored + Clone Script** | Considered | Simple but invisible to git - risky for CI/CD. |
| **Git Submodules** | **Chosen** | Native git support, explicit version tracking, works with automation. |
| **Worktree Mount** | Rejected | Too ephemeral - doesn't persist across clones. |

## Why Submodules Won (Despite Their Reputation)

Submodules are often criticized for:
1. Requiring `--recurse-submodules` on clone
2. Detached HEAD state confusing contributors
3. Extra complexity in CI/CD

**We mitigate all three:**

| Criticism | Mitigation |
|-----------|------------|
| Clone complexity | `setup-dev.sh` script automates initialization |
| Detached HEAD | Script checks out correct branch automatically |
| CI complexity | GitHub Actions handle sync - humans rarely touch it |
| Manual sync burden | **Fully automated** - push submodule, parent updates automatically |

**The key insight:** Submodules are problematic when manual, but excellent when automated.

## Why NOT Subtree (The Close Second)

Git subtree would normally be preferred for documentation because:
- Content appears as regular files (no `.git` pointer)
- No special clone flags needed
- Simpler mental model

**But it failed our use case** because the `docs-external` branch had overlapping paths with `main` (e.g., `ai-stack/claude-ollama/docs/`). Subtree works with a clean prefix like `docs-external/`, but can't intelligently merge into existing structure.

If starting fresh with flat documentation structure, subtree would be viable.

## The Automation Insight

The breakthrough was realizing that the main complaint about submodules - manual pointer updates - could be eliminated entirely with GitHub Actions:

```
Push to submodule repo
       │
       ▼
notify-parent.yml triggers repository_dispatch
       │
       ▼
update-submodules.yml auto-commits new SHA
       │
       ▼
Parent repo always has latest [skip ci]
```

This transforms submodules from "annoying manual process" to "fire-and-forget automation."

## Sync Models: Pull vs Push

There are two ways to implement the automation loop:

### Pull Model (Simpler Setup)

```
Parent workflow:
  - Checkout with submodules: recursive
  - git submodule update --init --recursive --remote
  - Commit if changed
```

**Pros:**
- Single workflow concept to understand
- Built-in scheduled fallback sync (every N hours)
- Works with existing `git submodule` mental model

**Cons:**
- **Requires PAT with access to ALL submodule repos**
- Fails if any submodule is private and PAT lacks access
- Each sync updates ALL submodules (not atomic per-submodule)
- More expensive runner time (clones all submodules)

### Push Model (More Robust)

```
Submodule workflow:
  - Sends repository_dispatch with {path, sha}

Parent workflow:
  - Checkout parent only (no submodules)
  - git update-index --cacheinfo 160000,<sha>,<path>
  - Commit
```

**Pros:**
- **Works with private submodules** - parent never needs submodule access
- PAT only needs parent repo permissions
- Atomic per-submodule commits with specific SHA
- Minimal runner time (no submodule clone)
- More secure (minimal credential scope)

**Cons:**
- Requires workflow in BOTH parent and each submodule
- No scheduled fallback (relies entirely on triggers)
- Slightly more complex mental model

### Which to Choose?

| Scenario | Recommendation |
|----------|----------------|
| Any private submodules | **Push Model** (required) |
| All public, simple setup | Either (Pull is simpler) |
| Security-conscious orgs | **Push Model** (minimal PAT scope) |
| Many submodules | **Push Model** (atomic commits) |
| Mixed visibility | **Push Model** |

### The Gitlink Trick

The push model relies on a git internals trick:

```bash
git update-index --cacheinfo 160000,<sha>,<path>
```

- Mode `160000` is git's special mode for submodule entries
- This updates the "gitlink" (pointer to submodule commit) without cloning
- Works entirely within the parent repo - no submodule access required

This technique was discovered while implementing submodules for a multi-repo architecture with private repos.

## Claude Code Hooks: The Safety Belt

After choosing submodules + GitHub Actions, we added local safety nets:
- **PostToolUse hook**: Blocks `git commit` in parent if submodules have uncommitted changes
- **Stop hook**: Checks for unpushed submodule commits at end of task

These hooks don't replace automation - they prevent mistakes that automation would have to clean up.

## Final Architecture

```
GitHub Actions = Main automation (async, handles sync)
Claude Code Hooks = Safety belt (sync, catches mistakes locally)
Submodules = Version-tracked content always present in working tree
```

This gives us:
- Docs accessible without branch switching
- Automation handles sync (no manual pointer updates)
- Local hooks prevent common mistakes
- Clean git history with explicit SHA tracking

## When to Choose This Architecture

**Good fit:**
- Content that changes independently of main code
- Multiple agents/humans working on different areas
- CI/CD pipelines that need deterministic content versions
- Documentation, exports, or configs that benefit from separate history

**Poor fit:**
- Tightly coupled code that must change together
- Single-developer projects where branches are fine
- Content that rarely changes (just commit it normally)
- Teams unfamiliar with git fundamentals

---

## External References

### Git Submodules

- [Git Book: Submodules](https://git-scm.com/book/en/v2/Git-Tools-Submodules) - Official Git documentation
- [Atlassian: Git Submodule Tutorial](https://www.atlassian.com/git/tutorials/git-submodule) - Comprehensive tutorial
- [gitsubmodules man page](https://git-scm.com/docs/gitsubmodules) - Configuration precedence and options
- [Best Practices for Git Submodules](https://blog.pixelfreestudio.com/best-practices-for-using-git-submodules/) - Practical recommendations

### Git Subtree vs Submodule (Why We Chose Submodules)

- [Atlassian: Git Subtree](https://www.atlassian.com/git/tutorials/git-subtree) - Subtree tutorial and comparison
- [GitProtect: Subtree vs Submodule](https://gitprotect.io/blog/managing-git-projects-git-subtree-vs-submodule/) - Detailed comparison
- [Against Submodules](https://blog.timhutt.co.uk/against-submodules/) - Common pitfalls (we mitigate with automation)

### GitHub Actions & Automation

- [GitHub: GITHUB_TOKEN Permissions](https://docs.github.com/en/actions/security-guides/automatic-token-authentication) - Why PAT is needed
- [Ultimate Guide to GitHub Actions Authentication](https://michaelheap.com/ultimate-guide-github-actions-authentication/) - Token types explained
- [peter-evans/repository-dispatch](https://github.com/peter-evans/repository-dispatch) - Action used for cross-repo triggers
- [Auto-Update Submodules Tutorial](https://tommoa.me/blog/github-auto-update-submodules/) - Similar implementation
- [GitHub Action: Submodule Updates](https://github.com/marketplace/actions/github-action-submodule-updates) - Alternative approach

### Git Hooks

- [Git Hooks Documentation](https://git-scm.com/docs/githooks) - Official reference
- [Atlassian: Git Hooks Tutorial](https://www.atlassian.com/git/tutorials/git-hooks) - Practical guide
- [pre-commit Framework](https://pre-commit.com/) - Related hook tooling

### Claude Code Integration

- [Claude Code Hooks Guide](https://docs.anthropic.com/en/docs/claude-code/hooks) - Official hooks documentation
- [Claude Code Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices) - Agent workflow patterns
