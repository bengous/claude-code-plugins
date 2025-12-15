---
description: Interactive git rebase with visual plan and AI-powered commit improvements
argument-hint: <branch|N|X..Y>
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/rebase/rebase":*)
model: claude-opus-4-5
---

# Interactive Rebase

Interactive rebase with AI assistance for commit message improvements and smart squashing.

<context>
Clean git history improves code review, debugging, and project understanding. This command reduces the manual effort of interactive rebase by:
- Showing a visual plan before execution
- Suggesting improved commit messages with AI
- Guiding through conflict resolution step-by-step
</context>

<usage>
```bash
# Rebase last N commits
/rebase 5
/rebase HEAD~5

# Rebase onto branch (rebase current branch until base)
/rebase main
/rebase dev

# Rebase specific range
/rebase HEAD~10..HEAD~5
```
</usage>

<features>
- Interactive commit action selection (pick/squash/reword/drop)
- Visual rebase plan with ASCII graph
- AI-powered reword suggestions (2-3 alternatives per commit)
- Smart squash messages (conventional commit aware)
- Conflict resolution guidance with step-by-step instructions
</features>

<workflow>
1. Validate clean working directory
2. Show commits in range
3. Prompt for actions on each commit (pick/squash/reword/drop)
4. Display visual rebase plan
5. Execute rebase
6. Handle conflicts with guidance
7. Report success or failure status
</workflow>

<actions>
- **pick (p)**: Keep commit as-is
- **squash (s)**: Combine with previous commit
- **reword (r)**: Change commit message with AI suggestions
- **drop (d)**: Remove commit from history
</actions>

<safety>
- Requires clean working directory (no uncommitted changes)
- Creates backup branch before starting
- Validates commit range exists
- Provides conflict resolution guidance
</safety>

<related>
- `/rebase:continue` - Resume after resolving conflicts
- `/rebase:abort` - Cancel rebase and cleanup
</related>

!"${CLAUDE_PLUGIN_ROOT}/scripts/rebase/rebase" $ARGUMENTS
