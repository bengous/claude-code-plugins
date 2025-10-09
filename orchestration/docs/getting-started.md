# Getting Started with Claude Orchestration

This guide will help you install and configure the Claude Orchestration plugin.

## Prerequisites

Before installing the plugin, ensure you have:

1. **Claude Code CLI** - Latest version
   ```bash
   # Check if installed
   claude --version
   ```

2. **Git** - Version 2.5 or higher (for worktree support)
   ```bash
   git --version
   ```

3. **GitHub CLI** - For issue and PR commands
   ```bash
   # Install gh CLI
   # macOS
   brew install gh

   # Linux
   # See: https://github.com/cli/cli/blob/trunk/docs/install_linux.md

   # Authenticate
   gh auth login
   ```

## Installation

### From Marketplace

The easiest way to install the plugin is from the Claude Code marketplace:

```bash
# Add the marketplace (first time only)
/plugin marketplace add bengous/claude-code-plugins

# Install the plugin
/plugin install claude-orchestration@bengolea-plugins
```

### Manual Installation

If you want to install from source:

```bash
# Clone the repository
git clone https://github.com/bengous/claude-code-plugins.git

# Navigate to your project
cd /path/to/your/project

# Create plugin directory if it doesn't exist
mkdir -p .claude-plugin

# Symlink the orchestration plugin
ln -s /path/to/claude-code-plugins/orchestration .claude-plugin/orchestration
```

## Verification

Verify the plugin is installed correctly:

```bash
# Check if commands are available
/worktree
/issue
/orc
/pr
```

You should see help text or command output for each.

## Initial Configuration

### 1. Set Up GitHub Repository

Ensure your project is a git repository with GitHub remote:

```bash
# Initialize git if needed
git init

# Add GitHub remote
git remote add origin https://github.com/yourusername/yourproject.git

# Verify remote
git remote -v
```

### 2. Create Base Branches

The orchestration system works best with a `dev` branch:

```bash
# Create dev branch from main/master
git checkout -b dev
git push -u origin dev

# Return to main
git checkout main
```

### 3. Initialize State Directory

The plugin uses `.claude/` for state management:

```bash
# Create state directories
mkdir -p .claude/run/locks
mkdir -p .claude/worktrees

# Add to .gitignore
echo ".claude/run/" >> .gitignore
echo ".claude/worktrees/" >> .gitignore
```

## First Steps

### Example 1: List Worktrees

```bash
/worktree
```

This will show all managed worktrees (empty on first run).

### Example 2: Create an Issue

```bash
/issue:create issue-title="Test issue for orchestration" \
              description="Testing the orchestration plugin" \
              priority=low
```

This creates a GitHub issue with automated labels.

### Example 3: Create a Worktree

```bash
/worktree:create test-feature --agent me --lock
```

This creates an isolated development environment.

### Example 4: Run Simple Orchestration

```bash
/orc:start "Add a comment to README" --confirm
```

This will:
1. Analyze the task
2. Classify it (likely SIMPLE)
3. Present a plan
4. Wait for your approval
5. Execute the task
6. Create a PR

## Understanding the Workflow

### The Three Paths

The orchestration system routes tasks based on complexity:

#### SIMPLE Path
- **Use for**: Documentation updates, typo fixes, trivial changes
- **Execution**: Direct work on current branch
- **Example**:
  ```bash
  /orc:start "Fix typo in login button"
  ```

#### MEDIUM Path
- **Use for**: Single-feature implementations, isolated bug fixes
- **Execution**: Optional worktree isolation, single PR
- **Example**:
  ```bash
  /orc:start "Add dark mode toggle to settings"
  ```

#### COMPLEX Path
- **Use for**: Multi-step features, architectural changes, refactoring
- **Execution**: Dedicated base branch, multiple sub-PRs, final integration PR
- **Example**:
  ```bash
  /orc:start "Refactor authentication system with OAuth support" --issue 42
  ```

### State Management

The plugin maintains state in `.claude/run/`:

```
.claude/run/
├── current.json              # Active orchestration
├── 2025-10-09-143052.json   # Historical runs
├── locks/                    # Concurrency control
│   └── feat-auth.lock
└── orc-plan-approved         # Approval markers
```

### Worktree Structure

Worktrees create parallel file trees:

```
your-project/                # Main worktree
├── .git/
├── src/
└── .claude/

../worktree-feature-a/       # Isolated worktree
├── src/                     # Independent files
└── node_modules/            # Separate dependencies

../worktree-feature-b/       # Another worktree
└── ...
```

## Common Commands

### Worktree Management

```bash
# List all worktrees
/worktree

# Create new worktree
/worktree:create feature-name --issue 123 --agent me --lock

# Check status
/worktree:status

# Lock worktree
/worktree:lock feature-name --agent me

# Delete worktree
/worktree:delete feature-name

# Clean up multiple worktrees
/worktree:prune --force
```

### Issue Management

```bash
# List open issues
/issue:list --state open

# Create issue
/issue:create issue-title="New feature request" priority=high

# View issue
/issue:view 123

# Add comment
/issue:comment 123 "Working on this now"

# Close issue
/issue:close 123
```

### Orchestration

```bash
# Start with confirmation
/orc:start "Task description" --confirm

# Force specific path
/orc:start "Task description" --force-path complex

# Specify base branch
/orc:start "Task description" --base staging

# Link to issue
/orc:start "Task description" --issue 42
```

### Pull Requests

```bash
# Create PR (idempotent)
/pr:create

# Specify branches
/pr:create --head feature-branch --base dev

# Custom title and body
/pr:create --title "Add feature X" --body "Description here"
```

## Safety Features

The plugin includes automatic safety hooks:

### 1. Worktree Guard
Prevents direct use of `git worktree` commands:
```bash
# Blocked
git worktree add ../new-worktree

# Use instead
/worktree:create new-worktree
```

### 2. PR Guard
Enforces COMPLEX mode PR rules:
```bash
# In COMPLEX mode, sub-PRs must target base branch, not dev
# The hook will block invalid PR targets automatically
```

### 3. Plan Mode
Ensures `/orc:start` uses planning phase:
```bash
# The hook ensures you can't skip classification
/orc:start "Task"  # → Forces PHASE 1: Plan Mode
```

## Troubleshooting

### Command Not Found

If commands aren't recognized:
```bash
# Reload Claude Code configuration
/plugin reload

# Or restart Claude Code session
```

### GitHub CLI Not Authenticated

```bash
# Authenticate with GitHub
gh auth login

# Verify authentication
gh auth status
```

### Worktree Creation Fails

```bash
# Check git version
git --version  # Should be 2.5+

# Ensure clean working tree
git status

# Try doctor command
/worktree:doctor
```

### State Corruption

```bash
# Check state directory
ls -la .claude/run/

# Reset if needed
rm -rf .claude/run/*
mkdir -p .claude/run/locks
```

## Next Steps

Now that you're set up, explore:

- **[Architecture](architecture.md)** - Understand the system design
- **[Workflows](workflows.md)** - Learn common development patterns
- **[Command Reference](commands/)** - Detailed command documentation
- **[Troubleshooting](troubleshooting.md)** - Solutions to common issues

## Quick Reference Card

```bash
# Essential Commands
/worktree                      # List worktrees
/worktree:create <name>        # Create worktree
/issue:create issue-title="..."  # Create issue
/orc:start "task" --confirm    # Orchestrate task
/pr:create                     # Create PR

# Status Checks
/worktree:status               # Worktree details
/issue:list                    # List issues
git status                     # Git status

# Cleanup
/worktree:delete <name>        # Remove worktree
/worktree:prune --force        # Clean multiple
```

---

**Ready to dive deeper?** Continue to [Architecture Documentation](architecture.md).
