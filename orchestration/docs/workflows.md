# Workflow Patterns

Common development patterns and best practices using the Claude Orchestration plugin.

## Table of Contents

1. [Solo Development Workflows](#solo-development-workflows)
2. [Multi-Agent Workflows](#multi-agent-workflows)
3. [Issue-Driven Development](#issue-driven-development)
4. [Complex Feature Development](#complex-feature-development)
5. [Hotfix Workflows](#hotfix-workflows)
6. [Maintenance Patterns](#maintenance-patterns)
7. [Anti-Patterns](#anti-patterns)

---

## Solo Development Workflows

### Pattern 1: Quick Fix

**Use Case:** Simple bug fixes, typos, documentation updates

```bash
# Make change directly
git checkout -b fix/typo-in-login dev
# Edit files...
git add .
git commit -m "Fix typo in login button text"

# Create PR
/pr:create --base dev
```

**Or with orchestration:**

```bash
/orc:start "Fix typo in login button text"

# → Classifies as SIMPLE
# → Makes changes
# → Creates PR automatically
```

### Pattern 2: Isolated Feature

**Use Case:** Medium-sized features that benefit from isolation

```bash
# Create isolated worktree
/worktree:create profile-page --agent me --lock --install

# Work in isolation
/worktree:run profile-page npm test
/worktree:run profile-page npm run dev

# Check progress
/worktree:status profile-page

# Create PR when ready
/pr:create --head worktree/profile-page-me --base dev

# Clean up after merge
/worktree:delete profile-page
```

**Or with orchestration:**

```bash
/orc:start "Add user profile page with avatar and settings" --confirm

# → Classifies as MEDIUM
# → Creates worktree for isolation
# → Implements feature
# → Creates PR automatically
# → Cleans up on completion
```

### Pattern 3: Exploratory Work

**Use Case:** Experimenting without affecting main worktree

```bash
# Create experiment worktree
/worktree:create experiment --agent me

# Try different approaches
/worktree:run experiment npm run build
# ... experiment ...

# If successful, create PR
/pr:create --head worktree/experiment-me --base dev

# If unsuccessful, just delete
/worktree:delete experiment --force
```

---

## Multi-Agent Workflows

### Pattern 1: Parallel Features

**Use Case:** Multiple agents working on independent features

```bash
# Agent 1: Authentication
/worktree:create auth --issue 42 --agent agent1 --lock
# Agent 1 works in auth worktree...

# Agent 2: Profile page
/worktree:create profile --issue 43 --agent agent2 --lock
# Agent 2 works in profile worktree...

# Agent 3: Notifications
/worktree:create notifications --issue 44 --agent agent3 --lock
# Agent 3 works in notifications worktree...

# Each agent creates PR independently
# No branch conflicts, no switching needed
```

**Status Monitoring:**

```bash
# Check all active work
/worktree:status

# Check specific worktree
/worktree:who auth
/worktree:logs auth
```

### Pattern 2: Sequential Delegation

**Use Case:** Passing work between agents

```bash
# Agent 1: Initial implementation
/worktree:create feature-x --agent agent1 --lock
# ... implement core functionality ...
/worktree:annotate feature-x "Core functionality complete"

# Transfer to Agent 2 for tests
/worktree:transfer feature-x --to agent2
# ... write tests ...
/worktree:annotate feature-x "Tests added"

# Transfer to Agent 3 for docs
/worktree:transfer feature-x --to agent3
# ... write documentation ...

# Create PR
/pr:create --head worktree/feature-x-agent3 --base dev
```

### Pattern 3: Coordinated Complex Feature

**Use Case:** Breaking down complex task across agents

```bash
# Orchestrator: Plan and create base
/orc:start "Build notification system" --issue 50 --confirm

# → Creates base: feat/notifications
# → Breaks into steps:
#   1. Backend API
#   2. Frontend UI
#   3. WebSocket integration

# Delegate Step 1 to Agent 1
/worktree:create notif-backend --agent agent1 --lock
git checkout -b feat/notifications-backend feat/notifications
# Agent 1 implements backend...
/pr:create --head feat/notifications-backend --base feat/notifications

# Delegate Step 2 to Agent 2
/worktree:create notif-frontend --agent agent2 --lock
git checkout -b feat/notifications-frontend feat/notifications
# Agent 2 implements frontend...
/pr:create --head feat/notifications-frontend --base feat/notifications

# After all steps merged, create final PR
git checkout feat/notifications
/pr:create --base dev
```

---

## Issue-Driven Development

### Pattern 1: Issue → Work → PR → Close

**Complete lifecycle:**

```bash
# 1. Create issue
/issue:create issue-title="Add dark mode support" \
              description="Implement dark mode with system preference detection" \
              labels="enhancement,frontend" \
              priority=high
# → Issue #60 created

# 2. Start work with issue link
/orc:start "Implement dark mode toggle" --issue 60 --confirm

# → Automatically:
#   • Fetches issue context
#   • Creates worktree: worktree/60-dark-mode
#   • Comments on issue with progress
#   • Links PR to issue

# 3. PR created automatically
# → PR #150: Add dark mode support
#   Body includes: "Closes #60"

# 4. Issue closed automatically when PR merges
```

### Pattern 2: Issue Triage → Orchestration

```bash
# List open issues
/issue:list --state open --label enhancement

# Pick high-priority issue
/issue:view 60

# Start orchestrated work
/orc:start "Implement the feature from issue 60" --issue 60

# Add progress comments
/issue:comment 60 "Backend implementation complete"
/issue:comment 60 "Frontend integration in progress"

# Close when done
/issue:close 60 comment="Completed in PR #150"
```

### Pattern 3: Label-Based Workflow

```bash
# Create issue with workflow labels
/issue:create issue-title="Refactor database layer" \
              labels="refactor,backend,ai-task" \
              priority=medium
# → Auto-adds: status:available

# Start work
/orc:start "Refactor database layer" --issue 65
# → Auto-updates label: status:in_progress

# On completion
# → Auto-updates label: status:completed
```

---

## Complex Feature Development

### Pattern 1: Feature with Sub-Components

**Use Case:** Large feature requiring multiple PRs

```bash
# Start orchestration
/orc:start "Build comprehensive user management system" --issue 70 --confirm

# → Classifies as COMPLEX
# → Creates base: feat/user-management
# → Decomposes:
#   Step 1: User model + database schema
#   Step 2: Authentication endpoints
#   Step 3: Profile management endpoints
#   Step 4: Admin dashboard
#   Step 5: Tests and documentation

# Each step:
# 1. Create step branch from base
# 2. Implement in isolation (possibly using worktree)
# 3. Create sub-PR → base branch
# 4. Review and merge to base
# 5. Move to next step

# Final step:
# - All sub-PRs merged to feat/user-management
# - Create final PR: feat/user-management → dev
# - Human review required for integration
```

### Pattern 2: Architectural Refactoring

**Use Case:** Cross-cutting changes with high risk

```bash
# Start with planning
/orc:start "Migrate from REST to GraphQL" --issue 75 --confirm

# → Classifies as COMPLEX
# → Creates base: refactor/graphql-migration

# Step 1: GraphQL schema
git checkout -b refactor/graphql-migration-schema refactor/graphql-migration
/worktree:create gql-schema --agent me --lock
# Implement schema...
/pr:create --head refactor/graphql-migration-schema --base refactor/graphql-migration
# Merge after review

# Step 2: Resolvers
git checkout -b refactor/graphql-migration-resolvers refactor/graphql-migration
/worktree:create gql-resolvers --agent agent1 --lock
# Implement resolvers...
/pr:create --head refactor/graphql-migration-resolvers --base refactor/graphql-migration
# Merge after review

# Step 3: Frontend migration
git checkout -b refactor/graphql-migration-frontend refactor/graphql-migration
/worktree:create gql-frontend --agent agent2 --lock
# Update frontend...
/pr:create --head refactor/graphql-migration-frontend --base refactor/graphql-migration
# Merge after review

# Step 4: Deprecate REST
git checkout -b refactor/graphql-migration-cleanup refactor/graphql-migration
# Remove old REST code...
/pr:create --head refactor/graphql-migration-cleanup --base refactor/graphql-migration
# Merge after review

# Final PR
git checkout refactor/graphql-migration
/pr:create --base dev
# → Requires extensive human review before merge
```

### Pattern 3: Incremental Rollout

**Use Case:** Feature flags and gradual deployment

```bash
# Create feature branch
git checkout -b feat/new-checkout-flow dev

# Step 1: Feature flag infrastructure
git checkout -b feat/checkout-flags feat/new-checkout-flow
# Add feature flags...
/pr:create --head feat/checkout-flags --base feat/new-checkout-flow

# Step 2: New checkout (behind flag)
git checkout -b feat/checkout-impl feat/new-checkout-flow
# Implement new flow...
/pr:create --head feat/checkout-impl --base feat/new-checkout-flow

# Step 3: A/B testing setup
git checkout -b feat/checkout-ab feat/new-checkout-flow
# Add A/B test...
/pr:create --head feat/checkout-ab --base feat/new-checkout-flow

# Deploy with flag disabled
git checkout feat/new-checkout-flow
/pr:create --base dev

# After merge and deploy:
# - Enable for 10% of users
# - Monitor metrics
# - Gradually increase percentage
# - Remove feature flag in follow-up PR
```

---

## Hotfix Workflows

### Pattern 1: Production Hotfix

**Use Case:** Critical bug in production

```bash
# Create hotfix from production
git checkout -b hotfix/critical-auth-bug production

# Fix the bug quickly
# ... make minimal changes ...

# Test thoroughly
npm test
npm run e2e

# Create PR to production
/pr:create --base production --title "HOTFIX: Fix authentication bypass vulnerability"

# After production merge, backport to dev
git checkout dev
git cherry-pick <hotfix-commit>
git push
```

### Pattern 2: Urgent Fix with Orchestration

```bash
# Use orchestration for structured fix
/orc:start "Fix critical authentication bypass" --base production --force-path simple

# → Works on production base
# → Creates fix
# → Creates PR to production
```

### Pattern 3: Multi-Branch Hotfix

**Use Case:** Fix needed in multiple versions

```bash
# Fix in main
git checkout -b hotfix/security-issue main
# ... fix ...
/pr:create --base main

# Cherry-pick to release branches
git checkout release/v2.0
git cherry-pick <fix-commit>
/pr:create --base release/v2.0

git checkout release/v1.9
git cherry-pick <fix-commit>
/pr:create --base release/v1.9
```

---

## Maintenance Patterns

### Pattern 1: Regular Cleanup

**Weekly maintenance:**

```bash
# Check worktree health
/worktree:doctor --fix

# Clean up old worktrees
/worktree:prune --dry-run
/worktree:prune

# Review open issues
/issue:list --state open

# Check for stale locks
ls .claude/run/locks/
# Remove if needed: rm .claude/run/locks/old-branch.lock
```

### Pattern 2: Periodic Reviews

**Monthly review:**

```bash
# List all issues
/issue:list --state all --limit 100

# Close stale issues
/issue:close 45 comment="Closing as stale"

# Review worktrees
/worktree:status

# Check orchestration history
ls .claude/run/
cat .claude/run/2025-10-*.json | jq .
```

### Pattern 3: Branch Hygiene

```bash
# List merged branches
git branch --merged dev

# Delete merged branches (except main/dev)
git branch --merged dev | grep -v "main\|dev" | xargs git branch -d

# Update from remote
git fetch --prune origin

# Clean up worktrees
/worktree:prune
```

---

## Anti-Patterns

### ❌ Anti-Pattern 1: Manual Git Worktree Commands

**Don't do this:**
```bash
git worktree add ../my-worktree
git worktree remove ../my-worktree
```

**Why:** Bypasses metadata tracking, breaks lock system.

**Do this instead:**
```bash
/worktree:create my-worktree
/worktree:delete my-worktree
```

### ❌ Anti-Pattern 2: Skipping Orchestration Planning

**Don't do this:**
```bash
# Complex task without planning
/orc:start "Major refactoring" --force-path simple
```

**Why:** Misses opportunity for structured approach, increases risk.

**Do this instead:**
```bash
# Let orchestration classify
/orc:start "Major refactoring" --confirm
# → Trust the COMPLEX classification
# → Follow structured approach
```

### ❌ Anti-Pattern 3: Manual State Manipulation

**Don't do this:**
```bash
# Manually editing state files
echo '{"type":"SIMPLE"}' > .claude/run/current.json
```

**Why:** Can corrupt state, break lock system.

**Do this instead:**
```bash
# Let orchestration manage state
# If state is corrupted:
rm .claude/run/current.json
/orc:start "New task"  # Start fresh
```

### ❌ Anti-Pattern 4: Premature PRs in COMPLEX Mode

**Don't do this:**
```bash
# In COMPLEX mode with base: feat/auth-system
git checkout feat/auth-system-step1
/pr:create --base dev  # ← BLOCKED by pr-guard.sh
```

**Why:** Bypasses incremental review, creates integration issues.

**Do this instead:**
```bash
# Create sub-PRs to base branch
/pr:create --head feat/auth-system-step1 --base feat/auth-system
# After all sub-PRs merged:
git checkout feat/auth-system
/pr:create --base dev
```

### ❌ Anti-Pattern 5: Ignoring Locks

**Don't do this:**
```bash
# Force delete locked worktree
/worktree:delete active-work --force
```

**Why:** Another agent may be actively working there.

**Do this instead:**
```bash
# Check lock status
/worktree:who active-work

# Contact owner or wait for completion
# If truly abandoned:
/worktree:unlock active-work
/worktree:delete active-work
```

### ❌ Anti-Pattern 6: Creating Issues Without Context

**Don't do this:**
```bash
/issue:create issue-title="Fix bug"
```

**Why:** No actionable information, hard to prioritize.

**Do this instead:**
```bash
/issue:create issue-title="Fix authentication timeout on slow networks" \
              description="Users report login timeouts on 3G connections. \
                          Issue appears to be 5-second timeout in auth service. \
                          Should increase to 30 seconds and add retry logic." \
              labels="bug,backend,authentication" \
              priority=high
```

---

## Workflow Decision Tree

```
Start Task
    │
    ├─ Is it trivial (<30 lines, single file)?
    │   ├─ YES → Use SIMPLE path
    │   │        • Work directly
    │   │        • /pr:create
    │   │
    │   └─ NO → Continue
    │
    ├─ Is it isolated (single module, no dependencies)?
    │   ├─ YES → Use MEDIUM path
    │   │        • Consider worktree for isolation
    │   │        • /orc:start (classifies as MEDIUM)
    │   │
    │   └─ NO → Continue
    │
    ├─ Is it complex (multi-module, cross-cutting)?
    │   ├─ YES → Use COMPLEX path
    │   │        • /orc:start --confirm
    │   │        • Trust classification
    │   │        • Follow sub-PR structure
    │   │
    │   └─ NO → Re-evaluate complexity
    │
    └─ When in doubt: /orc:start --confirm
                      Let orchestration decide
```

---

## Best Practices Summary

1. **Trust the Orchestration**
   - Let `/orc:start` classify tasks
   - Don't force paths unless necessary
   - Review plans in `--confirm` mode

2. **Use Worktrees for Isolation**
   - Parallel work without branch switching
   - Separate dependencies
   - Easy cleanup

3. **Link Issues to Work**
   - Create issues before starting
   - Use `--issue N` flag
   - Track progress with comments

4. **Incremental PRs for Complex Work**
   - Sub-PRs for reviewable chunks
   - Final PR for integration
   - Human review at key points

5. **Maintain State Hygiene**
   - Regular cleanup with `/worktree:prune`
   - Use `/worktree:doctor` for health checks
   - Don't manually edit state files

6. **Leverage Locks**
   - Lock worktrees for exclusive access
   - Check locks before deleting
   - Transfer ownership when delegating

---

**Next:** [Safety Hooks Documentation](hooks.md) for understanding automatic guards.
