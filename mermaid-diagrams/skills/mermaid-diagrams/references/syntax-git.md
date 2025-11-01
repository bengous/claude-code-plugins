# Git Graph Syntax Reference

Complete reference for Mermaid git graph diagrams.

## Basic Syntax

```mermaid
gitGraph
    commit
    commit
    branch develop
    commit
    commit
    checkout main
    commit
```

## Commits

### Simple Commit

```mermaid
gitGraph
    commit
    commit
    commit
```

### Commit with ID

```mermaid
gitGraph
    commit id: "Initial commit"
    commit id: "Add feature"
    commit id: "Fix bug"
```

### Commit with Tag

```mermaid
gitGraph
    commit
    commit tag: "v1.0"
    commit
    commit tag: "v1.1"
```

### Commit with Type

```mermaid
gitGraph
    commit type: NORMAL
    commit type: REVERSE
    commit type: HIGHLIGHT
```

**Commit types:**
- `NORMAL` - Standard commit (default)
- `REVERSE` - Merge commit or revert
- `HIGHLIGHT` - Important commit

### Commit with ID and Tag

```mermaid
gitGraph
    commit id: "feat: add login" tag: "v1.0.0"
    commit id: "fix: auth bug" tag: "v1.0.1"
```

## Branches

### Create Branch

```mermaid
gitGraph
    commit
    branch develop
    commit
```

### Checkout Branch

```mermaid
gitGraph
    commit
    branch develop
    commit
    checkout main
    commit
    checkout develop
    commit
```

### Multiple Branches

```mermaid
gitGraph
    commit
    branch develop
    commit
    branch feature
    commit
    commit
    checkout develop
    commit
    checkout main
    commit
```

## Merging

### Basic Merge

```mermaid
gitGraph
    commit
    branch develop
    commit
    commit
    checkout main
    merge develop
    commit
```

### Merge with ID

```mermaid
gitGraph
    commit
    branch feature
    commit id: "Add feature A"
    commit id: "Add feature B"
    checkout main
    merge feature id: "Merge feature branch"
```

### Merge with Tag

```mermaid
gitGraph
    commit
    branch develop
    commit
    commit
    checkout main
    merge develop tag: "v1.0"
```

## Cherry-pick

```mermaid
gitGraph
    commit id: "A"
    branch develop
    commit id: "B"
    commit id: "C"
    checkout main
    cherry-pick id: "C"
    commit id: "D"
```

## Practical Patterns

### Gitflow Workflow

```mermaid
gitGraph
    commit id: "Initial"
    
    branch develop
    checkout develop
    commit id: "Setup project"
    
    branch feature/login
    checkout feature/login
    commit id: "Add login form"
    commit id: "Add authentication"
    
    checkout develop
    merge feature/login id: "Merge login feature"
    
    branch feature/dashboard
    checkout feature/dashboard
    commit id: "Create dashboard"
    commit id: "Add charts"
    
    checkout develop
    merge feature/dashboard id: "Merge dashboard"
    
    branch release/1.0
    checkout release/1.0
    commit id: "Update version"
    commit id: "Update changelog"
    
    checkout main
    merge release/1.0 tag: "v1.0.0"
    
    checkout develop
    merge release/1.0 id: "Merge release to develop"
```

### Hotfix Workflow

```mermaid
gitGraph
    commit tag: "v1.0.0"
    branch develop
    checkout develop
    commit
    commit
    
    checkout main
    branch hotfix/critical-bug
    commit id: "Fix critical bug"
    commit id: "Add tests"
    
    checkout main
    merge hotfix/critical-bug tag: "v1.0.1"
    
    checkout develop
    merge hotfix/critical-bug id: "Merge hotfix to develop"
    
    checkout develop
    commit
```

### Feature Branch Workflow

```mermaid
gitGraph
    commit id: "Initial commit"
    
    branch feature/user-auth
    checkout feature/user-auth
    commit id: "Add login"
    commit id: "Add logout"
    commit id: "Add password reset"
    
    checkout main
    commit id: "Update docs"
    
    checkout feature/user-auth
    commit id: "Add tests"
    
    checkout main
    merge feature/user-auth id: "Merge: User authentication"
    commit tag: "v1.0"
```

### Release Workflow

```mermaid
gitGraph
    commit
    branch develop
    checkout develop
    commit
    commit
    
    branch release/2.0
    checkout release/2.0
    commit id: "Bump version to 2.0"
    commit id: "Update changelog"
    commit id: "Final testing"
    
    checkout main
    merge release/2.0 tag: "v2.0.0"
    
    checkout develop
    merge release/2.0
    commit id: "Continue development"
```

### Trunk-Based Development

```mermaid
gitGraph
    commit
    
    branch feature-1
    commit id: "Feature 1: WIP"
    
    checkout main
    branch feature-2
    commit id: "Feature 2: WIP"
    
    checkout main
    commit id: "Quick fix"
    
    checkout feature-1
    commit id: "Feature 1: Complete"
    checkout main
    merge feature-1
    
    checkout feature-2
    commit id: "Feature 2: Complete"
    checkout main
    merge feature-2
    
    commit tag: "release"
```

### Parallel Development

```mermaid
gitGraph
    commit id: "Start"
    
    branch team-a
    branch team-b
    
    checkout team-a
    commit id: "Team A: Feature 1"
    commit id: "Team A: Feature 2"
    
    checkout team-b
    commit id: "Team B: Feature 1"
    commit id: "Team B: Feature 2"
    
    checkout main
    merge team-a
    merge team-b
    
    commit tag: "Integration complete"
```

### Rebase Workflow

```mermaid
gitGraph
    commit id: "A"
    commit id: "B"
    
    branch feature
    commit id: "C"
    commit id: "D"
    
    checkout main
    commit id: "E"
    commit id: "F"
    
    %% Feature branch rebased onto main
    checkout feature
    commit id: "C'" type: HIGHLIGHT
    commit id: "D'" type: HIGHLIGHT
    
    checkout main
    merge feature id: "Fast-forward merge"
```

### Long-Running Branches

```mermaid
gitGraph
    commit id: "Init"
    
    branch develop
    branch staging
    
    checkout develop
    commit id: "Dev 1"
    commit id: "Dev 2"
    
    checkout staging
    merge develop
    commit id: "Staging tests"
    
    checkout main
    merge staging tag: "v1.0"
    
    checkout develop
    commit id: "Dev 3"
    commit id: "Dev 4"
    
    checkout staging
    merge develop
    commit id: "More tests"
    
    checkout main
    merge staging tag: "v1.1"
```

### Cherry-Pick Scenario

```mermaid
gitGraph
    commit id: "A"
    
    branch develop
    commit id: "B"
    commit id: "C - Critical fix"
    commit id: "D"
    
    checkout main
    cherry-pick id: "C - Critical fix"
    commit tag: "v1.0.1"
    
    checkout develop
    commit id: "E"
```

### Multiple Releases

```mermaid
gitGraph
    commit
    branch develop
    
    checkout develop
    commit id: "Feature 1"
    commit id: "Feature 2"
    
    branch release/1.0
    checkout release/1.0
    commit id: "RC1"
    checkout main
    merge release/1.0 tag: "v1.0"
    
    checkout develop
    merge release/1.0
    commit id: "Feature 3"
    commit id: "Feature 4"
    
    branch release/2.0
    checkout release/2.0
    commit id: "RC1"
    checkout main
    merge release/2.0 tag: "v2.0"
```

### Experimental Branch

```mermaid
gitGraph
    commit
    branch develop
    commit
    
    branch experimental
    checkout experimental
    commit id: "Try new approach"
    commit id: "Experiment more"
    commit id: "Looks promising"
    
    checkout develop
    commit id: "Regular work"
    
    %% Decide to merge experimental
    merge experimental id: "Adopt experimental feature"
    
    commit
    checkout main
    merge develop tag: "v2.0"
```

## Best Practices

### 1. Use Descriptive Commit IDs

```mermaid
%% ✅ GOOD
gitGraph
    commit id: "feat: add user authentication"
    commit id: "fix: resolve login timeout"
    commit id: "docs: update API documentation"

%% ❌ BAD
gitGraph
    commit id: "commit 1"
    commit id: "commit 2"
    commit id: "updates"
```

### 2. Tag Important Releases

```mermaid
gitGraph
    commit
    commit
    commit tag: "v1.0.0"
    commit
    commit tag: "v1.1.0"
```

### 3. Show Branch Purpose

```mermaid
gitGraph
    commit
    branch feature/user-profile
    branch hotfix/security-patch
    branch release/2.0
```

### 4. Highlight Important Commits

```mermaid
gitGraph
    commit
    commit
    commit id: "BREAKING CHANGE" type: HIGHLIGHT
    commit
```

### 5. Keep It Simple

Don't try to show every single commit:

```mermaid
%% ✅ GOOD - Show key commits
gitGraph
    commit id: "Start"
    commit id: "Major feature A"
    branch develop
    commit id: "Feature B"
    checkout main
    merge develop
    commit id: "Release" tag: "v1.0"

%% ❌ BAD - Too detailed
gitGraph
    commit id: "init"
    commit id: "add file 1"
    commit id: "add file 2"
    commit id: "fix typo"
    commit id: "fix another typo"
    %% ... 50 more commits
```

## Common Workflows Comparison

### Gitflow

```mermaid
gitGraph
    commit
    branch develop
    commit
    
    branch feature
    commit
    checkout develop
    merge feature
    
    branch release
    commit
    
    checkout main
    merge release tag: "v1.0"
    
    checkout develop
    merge release
```

### GitHub Flow

```mermaid
gitGraph
    commit tag: "v1.0"
    
    branch feature
    commit
    commit
    
    checkout main
    merge feature
    commit tag: "v1.1"
```

### GitLab Flow

```mermaid
gitGraph
    commit
    branch develop
    commit
    commit
    
    checkout main
    merge develop
    
    branch production
    checkout production
    merge main tag: "deploy"
```

## Advanced Patterns

### Multi-Team Development

```mermaid
gitGraph
    commit id: "Start sprint"
    
    branch frontend-team
    branch backend-team
    
    checkout frontend-team
    commit id: "UI component"
    commit id: "Styling"
    
    checkout backend-team
    commit id: "API endpoint"
    commit id: "Database schema"
    
    checkout main
    merge frontend-team
    merge backend-team
    commit id: "Integration" tag: "sprint-end"
```

### Version Maintenance

```mermaid
gitGraph
    commit tag: "v1.0"
    
    branch v1-maintenance
    commit
    
    checkout main
    commit tag: "v2.0"
    
    branch v2-maintenance
    commit
    
    checkout main
    commit tag: "v3.0"
    
    %% Bug fix to v1
    checkout v1-maintenance
    commit id: "Fix for v1" tag: "v1.0.1"
    
    %% Bug fix to v2
    checkout v2-maintenance
    commit id: "Fix for v2" tag: "v2.0.1"
```

## Common Pitfalls

### Branch Before Commit

```mermaid
%% ❌ WRONG - Need commit before branch
gitGraph
    branch develop  %% Error: no commits yet

%% ✅ CORRECT
gitGraph
    commit
    branch develop
```

### Checkout Before Merge

```mermaid
%% ✅ CORRECT - Checkout target branch first
gitGraph
    commit
    branch develop
    commit
    checkout main  %% Switch to main
    merge develop  %% Then merge
```

### Clear Branch Names

```mermaid
%% ❌ BAD
gitGraph
    commit
    branch b1
    branch b2

%% ✅ GOOD
gitGraph
    commit
    branch feature/login
    branch hotfix/security
```

## Syntax Quick Reference

```mermaid
gitGraph
    %% Commits
    commit
    commit id: "message"
    commit tag: "v1.0"
    commit type: HIGHLIGHT
    commit id: "message" tag: "v1.0" type: REVERSE
    
    %% Branches
    branch branch-name
    checkout branch-name
    
    %% Merge
    merge branch-name
    merge branch-name id: "merge message"
    merge branch-name tag: "v1.0"
    
    %% Cherry-pick
    cherry-pick id: "commit-id"
```

## When to Use Git Graphs

- Explaining branching strategies
- Documenting workflow processes
- Onboarding new team members
- Architecture decision records
- Release planning documentation
- Git training materials
- Workflow comparison diagrams
