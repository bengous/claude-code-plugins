# Analysis: Anthropic's feature-dev Plugin vs Orchestration Plugin

**Reference**: [Anthropic's feature-dev plugin](https://github.com/anthropics/claude-code/tree/main/plugins/feature-dev)

**Date**: 2025-10-12

**Purpose**: Document architectural differences to inform refactoring decisions

---

## Executive Summary

Anthropic's official `feature-dev` plugin uses a fundamentally different architecture than our orchestration plugin:

- **Single self-contained command file** vs multiple files with @ imports
- **Natural language enforcement** vs technical hooks for behavior control
- **TodoWrite for state** vs custom JSON state files
- **Heavy agent delegation** vs inline execution
- **Simple linear workflow** vs complex branching paths

**Key Insight**: Claude follows clear natural language instructions better than technical enforcement mechanisms (hooks, state files, imports).

---

## Architecture Comparison

### 1. File Structure

#### Anthropic's Approach ✅
```
feature-dev/
├── .claude-plugin/
│   └── plugin.json          # Minimal metadata
├── agents/
│   ├── code-explorer.md     # Specialized exploration agent
│   ├── code-architect.md    # Architecture design agent
│   └── code-reviewer.md     # Quality review agent
└── commands/
    └── feature-dev.md       # SINGLE self-contained file (~100 lines)
```

**Benefits**:
- All logic in one place
- No import dependencies
- Easy to read and understand
- Works reliably

#### Our Approach ❌
```
orchestration/
├── .claude-plugin/
│   └── plugin.json
├── commands/
│   ├── orc.md
│   ├── orc/
│   │   ├── start.md
│   │   └── _/                # Classification criteria split across files
│   │       ├── classification
│   │       ├── concurrency
│   │       ├── flags
│   │       ├── simple-path
│   │       ├── medium-path
│   │       ├── complex-path
│   │       └── ...
│   ├── worktree.md
│   ├── issue.md
│   └── pr.md
└── hooks/
    ├── planmode.sh          # Enforcement hooks
    ├── pr-guard.sh
    └── worktree-guard.py
```

**Problems**:
- @ imports don't work in plugins (resolve to project, not plugin directory)
- Complex file structure hard to maintain
- Hooks don't enforce behavior reliably
- Classification criteria scattered across multiple files

---

## 2. Import Strategy

### Anthropic: Everything Inline ✅

```markdown
## Phase 3: Clarifying Questions

**CRITICAL**: This is one of the most important phases. DO NOT SKIP.

**Actions**:
1. Review the codebase findings and original feature request
2. Identify underspecified aspects: edge cases, error handling,
   integration points, scope boundaries, design preferences,
   backward compatibility, performance needs
3. **Present all questions to the user in a clear, organized list**
4. **Wait for answers before proceeding to architecture design**
```

**Why it works**: All instructions are in the command file. No external dependencies.

### Our Approach: @ Imports (BROKEN) ❌

```markdown
## PHASE 1: PLAN MODE - Task Classification

@./_/concurrency
@./_/flags
@./_/classification
@./_/run-state

**Task to classify:** $ARGUMENTS
```

**Why it fails**:
1. `@` imports resolve relative to PROJECT `.claude/commands/`, not plugin location
2. When plugin is installed, paths like `./_/classification` look for `/home/user/project/.claude/commands/_/classification`
3. Files don't exist there, so Claude improvises

**Evidence from test**:
```
● I'll classify this task and execute it through the orchestration workflow.

  PHASE 1: Task Classification

  Task: "Add a dummy comment to README"

  Classification: SIMPLE  # <-- Improvised, didn't read classification criteria

  Rationale:
  - Single-file edit to an existing documentation file
  ...
```

---

## 3. Enforcement Mechanism

### Anthropic: Natural Language ✅

```markdown
## Phase 5: Implementation

**Goal**: Build the feature

**DO NOT START WITHOUT USER APPROVAL**

**Actions**:
1. Wait for explicit user approval
2. Read all relevant files identified in previous phases
...
```

**Why it works**:
- Bold, clear directive
- Claude respects emphatic instructions
- No complex technical mechanism needed

### Our Approach: Technical Hooks ❌

**planmode.sh** (UserPromptSubmit hook):
```bash
#!/bin/bash
set -euo pipefail

input=$(cat)
prompt=$(echo "${input}" | jq -r '.prompt // empty')

if [[ ! "${prompt}" =~ ^/claude-orchestration:(orc:start|orc) ]]; then
    exit 0
fi

cat >&2 <<EOF
📋 Plan Mode Enforced for /orc:start

The /orc:start command requires a planning phase first.

You must:
1. Analyze the task
2. Classify as SIMPLE/MEDIUM/COMPLEX
3. Present your plan and rationale
4. Wait for user approval before execution

Please proceed with PHASE 1: Task Classification.
EOF

exit 0  # Doesn't actually block - just shows message
```

**Why it fails**:
1. **Hook timing**: UserPromptSubmit fires before command execution, but doesn't block
2. **Matcher issues**: May not match slash commands properly
3. **Claude ignores it**: Sees message but continues execution anyway
4. **No actual enforcement**: `exit 0` doesn't prevent command from running

**Evidence**: Hook never appeared in test output. No enforcement happened.

---

## 4. State Management

### Anthropic: TodoWrite ✅

```markdown
## Core Principles

- **Use TodoWrite**: Track all progress throughout

## Phase 1: Discovery
**Actions**:
1. Create todo list with all phases
2. If feature unclear, ask user for details
3. Summarize understanding and confirm with user
```

**Benefits**:
- Built-in tool
- Visible to user
- Simple API
- No file I/O
- Persists across conversation

### Our Approach: Custom JSON Files ❌

```bash
# Create run state
RUN_ID=$(date +%Y-%m-%d-%H%M%S)
echo '{"type":"SIMPLE","base":null,"status":"planning","run_id":"'$RUN_ID'"}' > .claude/run/current.json

# Check marker file
marker_file=".claude/run/orc-plan-approved"
if [[ -f "${marker_file}" ]]; then
    rm -f "${marker_file}"
    exit 0
fi
```

**Problems**:
- Requires bash commands for file operations
- Hidden from user
- Fragile (file permissions, race conditions)
- Hard to debug
- Not visible in transcript
- Adds complexity

---

## 5. Agent Delegation

### Anthropic: Heavy Agent Use ✅

```markdown
## Phase 2: Codebase Exploration

**Actions**:
1. Launch 2-3 code-explorer agents in parallel. Each agent should:
   - Trace through the code comprehensively
   - Target a different aspect of the codebase
   - Include a list of 5-10 key files to read

**Example agent prompts**:
- "Find features similar to [feature] and trace through implementation"
- "Map the architecture and abstractions for [feature area]"
- "Analyze current implementation of [existing feature/area]"
- "Identify UI patterns, testing approaches relevant to [feature]"

2. Once agents return, read all files identified by agents
3. Present comprehensive summary of findings
```

**Benefits**:
- Specialized agents for different aspects
- Parallel execution for speed
- Agents return structured output (file lists)
- Clear delegation pattern

**Agent Definitions**:
- **code-explorer.md**: Deep codebase analysis, execution tracing
- **code-architect.md**: Design multiple approaches, provide blueprints
- **code-reviewer.md**: Bug detection, quality review, confidence scoring

### Our Approach: No Agent Delegation ❌

```markdown
Follow `./_/simple-path`.
Follow `./_/medium-path`.
Follow `./_/complex-path`.
```

**Problems**:
- No specialized analysis
- Misses opportunity for parallel execution
- Less thorough understanding of codebase
- Single-threaded execution

---

## 6. Workflow Complexity

### Anthropic: Linear & Simple ✅

**7 Sequential Phases**:
1. Discovery → Understand requirements
2. Codebase Exploration → Analyze existing code
3. Clarifying Questions → Resolve ambiguities
4. Architecture Design → Propose approaches
5. Implementation → Build the feature
6. Quality Review → Ensure correctness
7. Summary → Document outcomes

**Characteristics**:
- Single path for all features
- Clear progression
- Each phase builds on previous
- Easy to understand and follow
- Natural approval gates with bold text

### Our Approach: Complex Branching ❌

**3 Different Paths**:
- **SIMPLE**: Direct execution, no isolation
- **MEDIUM**: Worktree isolation, quality gates
- **COMPLEX**: Multi-worktree, sub-PRs, dependency graph

**Characteristics**:
- Classification required before execution
- Different rules per path
- Complex state machine (run IDs, locks, markers)
- Worktree management adds git complexity
- Multiple failure points

---

## 7. Command File Content

### Anthropic: feature-dev.md (Simplified)

```markdown
---
description: Guided feature development
argument-hint: Optional feature description
---

# Feature Development

## Core Principles
- Ask clarifying questions
- Understand before acting
- Simple and elegant
- Use TodoWrite

---

## Phase 1: Discovery
**Goal**: Understand what needs to be built
Initial request: $ARGUMENTS

**Actions**:
1. Create todo list with all phases
2. If unclear, ask user for requirements
3. Summarize and confirm

---

## Phase 2: Codebase Exploration
**Goal**: Understand existing code

**Actions**:
1. Launch 2-3 code-explorer agents in parallel
2. Read files identified by agents
3. Present comprehensive summary

---

## Phase 5: Implementation
**DO NOT START WITHOUT USER APPROVAL**

**Actions**:
1. Wait for explicit user approval
2. Read all relevant files
3. Implement following chosen architecture
...
```

**Key Features**:
- ~100 lines total
- Self-contained
- Natural language gates
- TodoWrite for state
- Agent delegation
- No technical enforcement

### Our Approach: orc/start.md

```markdown
---
description: Plan then route task into SIMPLE/MEDIUM/COMPLEX execution paths
argument-hint: <task_description> [--base <branch>] [--confirm] [--force-path]
---

## PHASE 1: PLAN MODE - Task Classification

@./_/concurrency        # ❌ Import fails
@./_/flags              # ❌ Import fails
@./_/classification     # ❌ Import fails
@./_/run-state          # ❌ Import fails

**Task to classify:** $ARGUMENTS

After classification, present decision:
- Path chosen (SIMPLE/MEDIUM/COMPLEX)
- Rationale
- Execution approach

### State Initialization
Write initial state: `echo '{"type":"<TYPE>","base":null}' > .claude/run/current.json`
Generate run-id: `RUN_ID=$(date +%Y-%m-%d-%H%M%S)`

**If `--confirm` flag:**
Follow `./_/approval`.  # ❌ Import fails

---

## PHASE 2: EXECUTION - Route and Execute

First, read `./_/locks`.  # ❌ Import fails

### Path A: SIMPLE
Follow `./_/simple-path`.  # ❌ Import fails

### Path B: MEDIUM
Follow `./_/medium-path`.  # ❌ Import fails

### Path C: COMPLEX
Follow `./_/complex-path`.  # ❌ Import fails

@./_/constraints  # ❌ Import fails
```

**Problems**:
- All @ imports broken
- Relies on external files that aren't accessible
- Complex bash state management
- No agent delegation
- Technical enforcement via hooks (doesn't work)

---

## Root Cause Analysis

### Why Our Plugin Doesn't Work As Expected

1. **@ Import Path Resolution** 🔴
   - Plugin commands use `@./_/file` syntax
   - Claude resolves relative to PROJECT `.claude/commands/`, not plugin location
   - Files don't exist at resolved paths
   - Claude improvises instead of following documented workflow

2. **Hook Timing & Enforcement** 🔴
   - UserPromptSubmit hooks fire but don't actually block execution
   - Natural language directives work better than technical hooks
   - Planmode hook never appeared in test (matcher issue or timing)
   - pr-guard.sh uses wrong hook type (should be PreToolUse on SlashCommand)

3. **State Management Complexity** 🟡
   - Custom JSON files hidden from user
   - Marker files for approval tracking
   - Bash commands for file operations
   - TodoWrite simpler and more visible

4. **Missing Agent Delegation** 🟡
   - No specialized agents for analysis
   - Misses parallel execution opportunities
   - Single-threaded workflow

5. **Workflow Complexity** 🟡
   - 3 branching paths harder to maintain than linear flow
   - More failure points
   - Harder to debug

---

## Recommendations for Refactoring

### Immediate Changes

1. **Inline All Content** 🔴 CRITICAL
   - Remove all @ imports
   - Copy classification criteria, path logic, constraints into main command file
   - Single self-contained orc.md file

2. **Replace Technical Enforcement** 🔴 CRITICAL
   - Remove planmode.sh hook
   - Use natural language: "**STOP. DO NOT PROCEED WITHOUT USER APPROVAL.**"
   - Use bold, emphatic directives like Anthropic

3. **Simplify State Management** 🟡 HIGH PRIORITY
   - Replace JSON files with TodoWrite
   - Remove marker files
   - Keep only essential bash commands for git operations

4. **Add Agent Delegation** 🟡 HIGH PRIORITY
   - Create specialized agents for:
     - Codebase exploration (find similar features)
     - Worktree management (check conflicts, merge status)
     - Quality review (test coverage, linting)
   - Launch agents in parallel where possible

5. **Simplify Workflow** 🟢 MEDIUM PRIORITY
   - Consider: Do we need 3 paths or can we have adaptive workflow?
   - Reduce branching complexity where possible
   - Clear phase progression like Anthropic

### Long-term Architecture

```markdown
---
description: Orchestrated task execution with classification and isolation
argument-hint: <task_description> [--base <branch>]
---

# Orchestration Workflow

**IMPORTANT: Follow each phase sequentially. DO NOT skip phases or improvise.**

## Core Principles
- **Use TodoWrite**: Track all progress
- **Ask before acting**: Get user approval at key decision points
- **Understand codebase**: Launch agents to explore before implementing

---

## Phase 1: Task Classification

**Goal**: Classify as SIMPLE, MEDIUM, or COMPLEX

**Classification Criteria** (inline):

**SIMPLE**: Single file, < 50 lines, no tests, current worktree
**MEDIUM**: Multiple files, < 200 lines, tests required, isolated worktree
**COMPLEX**: Multiple modules, architecture changes, multi-worktree workflow

**Actions**:
1. Create TodoWrite with all phases
2. Analyze task against criteria
3. Present classification with rationale
4. **STOP. WAIT FOR USER CONFIRMATION.**

---

## Phase 2: Codebase Understanding (MEDIUM/COMPLEX only)

**Goal**: Understand existing patterns and identify integration points

**Actions**:
1. Launch code-explorer agents to analyze:
   - Similar features and their implementation
   - Module boundaries and dependencies
   - Testing patterns and conventions
2. Read files identified by agents
3. Present summary of findings

---

## Phase 3: Execution

**DO NOT START WITHOUT USER APPROVAL FROM PHASE 1**

### Path A: SIMPLE
... (inline, no imports)

### Path B: MEDIUM
... (inline, no imports)

### Path C: COMPLEX
... (inline, no imports)

---

## Phase 4: Quality Review

**Actions**:
1. Launch code-reviewer agent for final check
2. Present findings
3. Address critical issues

---

## Phase 5: Summary

**Actions**:
1. Mark todos complete
2. Summarize what was built
3. Suggest next steps
```

---

## Key Takeaways

1. **Claude follows natural language better than technical enforcement**
   - Bold directives > hooks
   - Clear instructions > state files
   - TodoWrite > custom JSON

2. **Plugin @ imports are project-scoped, not plugin-scoped**
   - Must inline all content
   - Or use agents to fetch content dynamically

3. **Simplicity wins**
   - Single file > multiple imports
   - Linear flow > complex branching
   - Visible state > hidden files

4. **Agent delegation is powerful**
   - Parallel execution
   - Specialized analysis
   - Structured outputs

5. **Hooks are for blocking tools, not enforcing workflow**
   - worktree-guard.py works (blocks Bash tool)
   - planmode.sh doesn't work (can't enforce natural language workflow)

---

## Action Items

- [ ] Create refactored orc.md with inline content
- [ ] Design specialized agents (worktree-manager, code-explorer)
- [ ] Remove planmode.sh and pr-guard.sh hooks
- [ ] Simplify state management using TodoWrite
- [ ] Test with dummy task to verify behavior
- [ ] Update documentation

---

## References

- [Anthropic feature-dev plugin](https://github.com/anthropics/claude-code/tree/main/plugins/feature-dev)
- [Claude Code plugin docs](https://docs.claude.com/en/docs/claude-code/plugins)
- [Hook reference](https://docs.claude.com/en/docs/claude-code/hooks)
