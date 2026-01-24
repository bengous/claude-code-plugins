# Claude Code Plugin Modernization Strategy
## Deep Research Report

**Date:** January 24, 2026  
**Scope:** Claude Code Architecture, Prompt-as-Code Patterns, Plugin Audit Framework

---

## Executive Summary

This research report provides comprehensive guidance for modernizing Claude Code plugins from "artisanal" passive prompts to programmatic, tool-active patterns. Based on extensive research of official Anthropic documentation, community best practices, and direct Claude Code v2.1.19 system queries, this document delivers:

1. **Complete Tool Vocabulary** with usage patterns and parameters
2. **Task Management Suite** (TaskCreate, TaskUpdate, TaskList, TaskGet, TaskOutput, TaskStop)
3. **Prompt-as-Code Patterns** for active tool orchestration
4. **Audit Checklist** with scoring rubrics
5. **Transformation Recipes** with before/after examples
6. **Architecture Recommendations** for the Plugin Modernizer

> **January 2026 Update:** Full documentation for Task Management tools (7 tools total) including background task handling with TaskOutput/TaskStop. TeammateTool infrastructure documented (feature-flagged but fully built).

---

## Part 1: Claude Code Tool Reference

### 1.1 Complete Tool Inventory

Claude Code provides **20+ built-in tools** that agents can invoke. Understanding when and how to use each is critical for modernization.

#### Core File Operations

| Tool | Purpose | Key Parameters | Token Cost |
|------|---------|----------------|------------|
| **Read** | Read file contents | `file_path`, `start_line`, `end_line` | ~439 tokens |
| **Write** | Create/overwrite files | `file_path`, `content` | ~159 tokens |
| **Edit** | String replacement in files | `file_path`, `old_str`, `new_str` | ~278 tokens |
| **Glob** | Find files by pattern | `pattern`, `path` | ~122 tokens |
| **Grep** | Search content (ripgrep) | `pattern`, `path`, `include` | ~300 tokens |

#### Execution Tools

| Tool | Purpose | Key Parameters | Token Cost |
|------|---------|----------------|------------|
| **Bash** | Execute shell commands | `command`, `description` | ~1074 tokens |
| **Task** | Launch subagents | `subagent_type`, `prompt`, `description`, `run_in_background` | ~1311 tokens |

#### Task Management (NEW in v2.1.x)

| Tool | Purpose | Key Parameters | Token Cost |
|------|---------|----------------|------------|
| **TaskCreate** | Create task with dependencies | `subject`, `description`, `activeForm`, `metadata` | ~570 tokens |
| **TaskUpdate** | Modify task status/deps | `taskId`, `status`, `owner`, `addBlocks`, `addBlockedBy` | ~400 tokens |
| **TaskList** | List all tasks | (none) | ~313 tokens |
| **TaskGet** | Get specific task state | `taskId` | ~200 tokens |
| **TaskOutput** | Get background task output | `task_id`, `block`, `timeout` | ~250 tokens |
| **TaskStop** | Terminate background task | `task_id` | ~150 tokens |
| **TeammateTool** | Multi-agent coordination | `operation`, `team_name`, `agent_id` | ~3811 tokens |

#### Planning & Organization

| Tool | Purpose | Key Parameters | Token Cost |
|------|---------|----------------|------------|
| **TodoWrite** | Create/manage task lists | `todos[]` with `content`, `status`, `activeForm` | ~2167 tokens |
| **EnterPlanMode** | Enter planning mode | N/A | ~773 tokens |
| **ExitPlanMode** | Present plan for approval | `plan` | ~450 tokens |

#### Web & External

| Tool | Purpose | Key Parameters | Token Cost |
|------|---------|----------------|------------|
| **WebSearch** | Search the web | `query` | ~334 tokens |
| **WebFetch** | Fetch URL content | `url` | ~278 tokens |

#### Skills & Extensions

| Tool | Purpose | Key Parameters | Token Cost |
|------|---------|----------------|------------|
| **Skill** | Load skill instructions | `skill_name` | ~279 tokens |
| **SlashCommand** | Execute slash commands | `command_name`, `args` | ~355 tokens |

### 1.2 Task Tool Deep Dive

The **Task tool** (~1,311 tokens) is critical for parallel execution and context isolation. Here's the complete specification:

```javascript
Task({
  subagent_type: "general-purpose" | "Explore" | "Plan" | "custom-agent-name",
  description: "3-5 word summary",  // REQUIRED
  prompt: "Detailed task instructions",  // REQUIRED
  run_in_background: true | false,  // Optional, default false
  // resume: "agent_id"  // For resuming previous agents
})
```

#### Subagent Types

| Type | Tools Available | Use Case |
|------|-----------------|----------|
| **general-purpose** | Read, Write, Edit, Bash, Grep, Glob, WebFetch, WebSearch | Full autonomous work |
| **Explore** | Glob, Grep, Read, limited Bash | Read-only codebase exploration |
| **Plan** | Read, Grep, Glob | Planning without execution |
| **Custom** | Configured per agent definition | Domain-specific tasks |

#### Task Execution Patterns

**Sequential Pipeline:**
```
Task("Research API") → Task("Implement endpoint") → Task("Write tests")
```

**Parallel Fan-Out (up to 10 concurrent):**
```javascript
// Claude can invoke multiple Task tools in a single response
Task({ prompt: "Analyze auth module" })
Task({ prompt: "Analyze database layer" })
Task({ prompt: "Analyze API routes" })
// All three run concurrently
```

**Background Execution:**
```javascript
Task({
  subagent_type: "general-purpose",
  prompt: "Run test suite and report failures",
  run_in_background: true  // Non-blocking
})
```

### 1.3 Task Management Tools (NEW in v2.1.x)

> **Status Update (January 2026):** Claude Code v2.1.x introduced a new suite of task tracking tools that supersede the older TodoWrite approach for multi-agent workflows. These tools enable dependency-aware task graphs and team coordination.

#### TaskCreate (~570 tokens)

Creates a new task in the session's task list with dependency tracking.

```javascript
TaskCreate({
  // Required
  subject: "Review landing page metadata",      // Brief title (imperative verb)
  description: "Check SEO tags, Open Graph...", // Detailed requirements
  
  // Optional
  activeForm: "Reviewing metadata",  // Spinner text while in progress
  metadata: {                        // Arbitrary key-value pairs
    pr_number: 1588,
    file_path: "app/views/landing.html"
  }
})
// Returns: { taskId: string }
```

**When to Use TaskCreate:**
- Complex multi-step tasks (3+ steps)
- User provides multiple tasks
- Plan mode tracking
- Coordinating parallel work across agents

#### TaskUpdate

Modifies task status, dependencies, and metadata.

```javascript
TaskUpdate({
  // Required
  taskId: "1",
  
  // Optional - Status
  status: "in_progress",        // "pending" | "in_progress" | "completed"
  
  // Optional - Content
  subject: "Updated title",
  description: "New details",
  activeForm: "Processing...",
  
  // Optional - Ownership (multi-agent)
  owner: "agent-id",            // Claim task for this agent
  
  // Optional - Dependencies (incremental)
  addBlocks: ["2", "3"],        // Task IDs this blocks (downstream)
  addBlockedBy: ["4"],          // Task IDs blocking this (upstream)
  
  // Optional - Metadata
  metadata: { key: "value" }    // Merge into existing (null deletes key)
})
```

**Status Workflow:** `pending` → `in_progress` → `completed`

**Staleness Guidance:**
- Always call TaskGet before updating to read latest state
- Teammates may have added comments while you were working
- Call TaskList after resolving a task to check unblocked work

#### TaskGet

Retrieves full task details by ID.

```javascript
TaskGet({
  taskId: "1"   // Required
})
// Returns:
{
  id: "1",
  subject: "Review landing page",
  description: "Full description...",
  status: "in_progress",
  owner: "agent-abc123",
  blocks: ["2", "3"],       // Tasks waiting on this
  blockedBy: [],            // Tasks this waits for
  metadata: { pr_number: 1588 }
}
```

#### TaskList (~313 tokens)

Lists all tasks with summary info.

```javascript
TaskList({})  // No parameters required
// Returns array:
[
  {
    id: "1",
    subject: "Review landing page",
    status: "in_progress",
    owner: "agent-abc123",
    blockedBy: []           // Only open blocking task IDs
  },
  // ...
]
```

**Use Cases:**
- Find available work (pending, no owner, not blocked)
- Check overall progress
- Find blocked tasks needing resolution

#### TaskOutput

Retrieves output from running/completed background tasks.

```javascript
TaskOutput({
  task_id: "bg-task-123",     // Required
  block: true,                 // Wait for completion (default: true)
  timeout: 30000               // Max wait ms (default: 30000, max: 600000)
})
```

**Works With:**
- Background shell commands (`Bash` with `run_in_background`)
- Background agents (`Task` with `run_in_background: true`)
- Remote sessions

#### TaskStop

Terminates a running background task.

```javascript
TaskStop({
  task_id: "bg-task-123"      // Required
})
// Returns success/failure status
```

**Task Lifecycle:**

```
PENDING → IN_PROGRESS → COMPLETED
    ↑                      |
    └──────────────────────┘
        (if reopened)
```

**Storage & Persistence:**

```
~/.claude/tasks/{CLAUDE_CODE_TASK_LIST_ID}/
    task-1.json
    task-2.json
    ...
```

| Configuration | Behavior |
|--------------|----------|
| Default | `TASK_LIST_ID = session_id` (ephemeral, lost on `/clear`) |
| Persistent | Set `CLAUDE_CODE_TASK_LIST_ID=my-project` env var |
| Cross-session | Multiple terminals with same ID share tasks |

**Dependency Resolution Flow:**

```
┌─────────────────────────────────────────────────┐
│ Task #1 (pending)                               │
│ blocks: [2, 3]                                  │
└─────────────────────────────────────────────────┘
         │
         ▼ (completing #1 unblocks downstream)
┌─────────────────┐  ┌─────────────────┐
│ Task #2         │  │ Task #3         │
│ blockedBy: [1]  │  │ blockedBy: [1]  │
└─────────────────┘  └─────────────────┘
```

### 1.4 Two Different "Task" Concepts

The naming is confusing because Task() spawns subagents while TaskCreate/Update/List/Get manage a coordination list:

| Tool | Purpose | Think of it as |
|------|---------|----------------|
| `Task()` | Spawn subagent to do work | "Do this work" (the worker) |
| `TaskCreate/Update/List/Get` | Track work in shared list | "Track this work item" (coordination layer) |

**They're Complementary:**
```javascript
// 1. Create tracking entry
TaskCreate(subject: "EXPLORE: auth", description: "...")  // → id: "1"

// 2. Spawn worker to do it
Task(subagent_type: "Explore", prompt: "Find auth files", run_in_background: true)

// 3. [subagent completes]

// 4. Update tracking
TaskUpdate(taskId: "1", status: "completed")
```

### 1.5 TeammateTool (Hidden/Feature-Flagged)

> **Status:** TeammateTool exists in Claude Code v2.1.x but is currently behind feature flags (`I9() && qFB()`). The infrastructure is fully built but not user-accessible.

TeammateTool enables multi-agent team coordination with these operations:

| Operation | Purpose | Parameters |
|-----------|---------|------------|
| `spawnTeam` | Create a new team | `name`, `description` |
| `discoverTeams` | List available teams | - |
| `requestJoin` | Request to join a team | `team_id` |
| `approveJoin` / `rejectJoin` | Respond to join requests | `agent_id` |
| `write` | Send message to specific agent | `agent_id`, `message` |
| `broadcast` | Send message to all team members | `message` |
| `requestShutdown` | Initiate graceful shutdown | `reason` |
| `approveShutdown` / `rejectShutdown` | Respond to shutdown | - |
| `cleanup` | Remove team and task directories | `team_id` |

**Team File Structure (when enabled):**
```
~/.claude/
├── teams/
│   └── {team-id}/
│       ├── config.json        # Team metadata, leader, members
│       └── messages/
│           └── {agent-id}/    # Inbox per agent
├── tasks/
│   └── {team-id}/
│       ├── 1.json             # Task files with dependencies
│       ├── 2.json
│       └── ...
```

**Token Cost:** ~3,811 tokens (the largest tool description)

**Workaround Until Enabled:**
Use file-based coordination via Task tool with shared state files:
```javascript
// Orchestrator creates shared state
Write(".claude/team-state.json", JSON.stringify({ tasks: [...] }))

// Background agents read and update
Task({ 
  prompt: "Read .claude/team-state.json, claim task #2, execute, update status",
  run_in_background: true 
})
```

### 1.6 TodoWrite vs Task Management Tools

| Feature | TodoWrite | Task Management (TaskCreate/Update/List/Get/Output/Stop) |
|---------|-----------|----------------------------------------------------------|
| **Purpose** | Progress tracking display | Multi-agent coordination |
| **Persistence** | Session UI only | File-based (`~/.claude/tasks/{ID}/`) |
| **Dependencies** | None | `addBlocks`/`addBlockedBy` relationships |
| **Ownership** | Single agent | Multi-agent with `owner` field |
| **Background execution** | No | Yes via TaskOutput/TaskStop |
| **Cross-session** | No | Yes via `CLAUDE_CODE_TASK_LIST_ID` |
| **Token cost** | ~2,167 tokens | ~570 + 400 + 313 + 200 tokens |

**When to Use Each:**
- **TodoWrite**: Single-agent workflows, user progress visibility, simple task lists
- **Task Management**: Multi-agent orchestration, dependency chains, parallel work, persistent coordination

### 1.7 MCP (Model Context Protocol) Integration

MCP enables dynamic tool discovery and external service integration.

#### Tool Naming Convention
```
mcp__<server-name>__<tool-name>
// Example: mcp__github__list_issues
```

#### Tool Search (Auto-enabled when tools exceed 10% of context)
- **Regex mode**: Precise pattern matching (`"get_.*_data"`)
- **BM25 mode**: Semantic similarity search
- **On-demand loading**: 3-5 tools per query (~3K tokens vs 77K upfront)

#### Configuration Locations
```
~/.claude.json              # Global user config
./.claude.json              # Project config  
./.mcp.json                 # Shared MCP config (check into git)
```

### 1.8 Tool Composition Best Practices

**DO:**
- Batch independent tool calls in a single response
- Use Grep/Glob before Read to minimize file reads
- Delegate verbose operations to subagents
- Use CLI tools (gh, aws, gcloud) over MCP when available (lower token cost)

**DON'T:**
- Make sequential calls when parallel is possible
- Read entire files when line ranges suffice
- Use cat/head/tail when Read tool is available
- Hardcode file paths—use Glob to discover

---

## Part 2: Prompt-as-Code Patterns

### 2.1 Passive vs Active Prompts

| Passive (Artisanal) | Active (Programmatic) |
|---------------------|----------------------|
| Describes what Claude should know | Orchestrates what Claude should do |
| Context is embedded inline | Context is loaded on-demand via Skill() |
| Sequential human reasoning | Parallel tool invocation |
| Implicit tool selection | Explicit tool calls with parameters |
| Static workflow | Dynamic, conditional execution |

#### Example Transformation

**❌ Passive (Before):**
```markdown
# Code Review Prompt
You are a code reviewer. When reviewing code:
1. Check for security issues
2. Look for performance problems
3. Ensure code style compliance
4. Verify test coverage

Here are the coding standards: [500 lines of embedded docs]
```

**✅ Active (After):**
```markdown
# Code Review Prompt
---
allowed-tools: Read, Grep, Glob, Task, Skill
---

## Execution Steps
1. Skill("coding-standards") → Load project conventions
2. Glob("*.{ts,tsx}") → Discover modified files
3. Parallel Tasks:
   - Task("Security audit: Check for injection, auth issues")
   - Task("Performance: Identify N+1 queries, memory leaks")
   - Task("Style: Verify ESLint compliance")
4. Read(test files) → Verify coverage exists
5. Synthesize findings into structured report
```

### 2.2 Core Patterns Library

#### Pattern 1: Progressive Skill Loading

Load references on-demand rather than embedding inline.

```markdown
## Context Loading
- For TypeScript patterns → Skill("typescript-conventions")
- For API design → Skill("api-design-guidelines")  
- For testing → Skill("testing-strategy")

## Trigger Words
| Keywords | Load Skill |
|----------|------------|
| "authentication", "login", "session" | auth-patterns |
| "database", "query", "migration" | database-conventions |
| "deploy", "release", "ci/cd" | deployment-workflow |
```

#### Pattern 2: Fan-Out Research

Parallel information gathering with synthesis.

```markdown
## Research Phase
Execute in parallel:
1. Task("Search codebase for related implementations")
2. Task("Check documentation for existing patterns")
3. Task("Analyze dependencies for conflicts")
4. Task("Review recent git history for context")

## Synthesis Phase
Aggregate subagent results → Generate unified analysis
```

#### Pattern 3: Debate/Consensus Workflow

Multi-perspective analysis with conflict resolution.

```markdown
## Debate Architecture
1. Task(Advocate): "Argue FOR this approach, cite benefits"
2. Task(Critic): "Argue AGAINST, identify risks and alternatives"
3. Task(Synthesizer): "Given {advocate_result} and {critic_result}, recommend optimal path"

## Consensus Rules
- If both agree → Proceed with confidence
- If conflict → Present options to user with tradeoffs
- If critical risk identified → Block and escalate
```

#### Pattern 4: Execute vs Teach

Agent performs work vs explains how to work.

```markdown
## Mode Selection
IF user says "show me how" OR "explain" OR "teach":
  → TEACH mode: Explain steps without executing
  → Include code snippets user can run
  → No actual file modifications

ELSE:
  → EXECUTE mode: Perform the work
  → Make actual changes
  → Report results
```

#### Pattern 5: Stateless Agent Composition

Full context upfront, single return value.

```markdown
## Agent Contract
INPUT: Complete context including:
- Current codebase state (via Glob/Grep results)
- User requirements (explicit prompt)
- Constraints (tool restrictions, file boundaries)

OUTPUT: Single structured response containing:
- Summary of findings/actions
- File paths modified
- Recommendations for follow-up
- Errors encountered

NO: Multi-turn clarification, state persistence, external queries
```

### 2.3 Tool Invocation Syntax

Within prompts, tools can be referenced declaratively:

```markdown
## Allowed Tools
allowed-tools: Read, Write, Edit, Bash(npm *), Task

## Dynamic Context (Shell Expansion)
- Current branch: !`git branch --show-current`
- Changed files: !`git diff --name-only HEAD~1`
- Test status: !`npm test --silent`

## Conditional Execution
IF !`test -f package-lock.json` exists:
  → Use npm
ELSE IF !`test -f yarn.lock` exists:
  → Use yarn
```

---

## Part 3: Plugin Audit Framework

### 3.1 Audit Checklist

Score each dimension 1-5 (1=needs work, 5=fully modern).

#### Dimension 1: Tool Activity Score

| Score | Criteria |
|-------|----------|
| 1 | Prompt only describes what to do, no tool references |
| 2 | Mentions tools but doesn't specify parameters |
| 3 | Specifies some tools with basic parameters |
| 4 | Clear tool orchestration with conditional logic |
| 5 | Full programmatic control with parallel execution |

**Check:**
- [ ] Does the prompt invoke tools explicitly?
- [ ] Are tool parameters specified (not left to inference)?
- [ ] Is there conditional tool selection based on context?
- [ ] Are parallel-capable operations expressed as parallel calls?

#### Dimension 2: Token Efficiency Score

| Score | Criteria |
|-------|----------|
| 1 | Large docs embedded inline (>500 lines) |
| 2 | Some docs embedded, some referenced |
| 3 | Most docs referenced via Skill() |
| 4 | On-demand loading with trigger keywords |
| 5 | Minimal base prompt, all context loaded dynamically |

**Check:**
- [ ] Are reference docs embedded or loaded via Skill()?
- [ ] Is there a trigger keyword table for skill loading?
- [ ] Does the prompt use `@imports` or file references?
- [ ] Is verbose output delegated to subagents?

#### Dimension 3: Parallelization Score

| Score | Criteria |
|-------|----------|
| 1 | All operations sequential |
| 2 | Sequential but acknowledges parallel possibility |
| 3 | Some operations parallelized |
| 4 | Clear parallel phases identified |
| 5 | Full fan-out/fan-in patterns with synthesis |

**Check:**
- [ ] Are independent research tasks parallelized?
- [ ] Do exploration phases use multiple subagents?
- [ ] Is there explicit fan-out/fan-in structure?
- [ ] Are results synthesized from parallel agents?

#### Dimension 4: MCP Integration Score

| Score | Criteria |
|-------|----------|
| 1 | No MCP awareness |
| 2 | Hardcoded MCP tool calls |
| 3 | Some dynamic tool discovery |
| 4 | Tool search with fallbacks |
| 5 | Full MCP-first architecture with caching |

**Check:**
- [ ] Does the plugin use MCP for external services?
- [ ] Is tool discovery dynamic (not hardcoded)?
- [ ] Are MCP outputs filtered/summarized?
- [ ] Is there caching for expensive MCP operations?

#### Dimension 5: Error Handling Score

| Score | Criteria |
|-------|----------|
| 1 | Assumes all operations succeed |
| 2 | Basic error acknowledgment |
| 3 | Explicit error checks with user prompts |
| 4 | Fallback strategies defined |
| 5 | Full recovery patterns with retry logic |

**Check:**
- [ ] Are tool failures handled explicitly?
- [ ] Are there fallback strategies for common failures?
- [ ] Does the prompt handle missing files/permissions?
- [ ] Is there guidance for partial completion scenarios?

#### Dimension 6: State Management Score

| Score | Criteria |
|-------|----------|
| 1 | Global state assumptions |
| 2 | Some scoping awareness |
| 3 | Repository-scoped state |
| 4 | Session-scoped with persistence hooks |
| 5 | Full state isolation with explicit handoffs |

**Check:**
- [ ] Is state repository-scoped (not global)?
- [ ] Are session boundaries clearly defined?
- [ ] Is there explicit context handoff between phases?
- [ ] Does it use CLAUDE.local.md for persistent memory?

### 3.2 Scoring Rubric

| Total Score | Modernization Status |
|-------------|---------------------|
| 25-30 | **Modern** - Minimal changes needed |
| 19-24 | **Transitional** - Targeted improvements |
| 13-18 | **Legacy** - Significant refactoring required |
| 6-12 | **Artisanal** - Full rewrite recommended |

### 3.3 Priority Matrix

Prioritize modernization by **Impact × Effort**:

| Plugin Type | Impact | Effort | Priority |
|-------------|--------|--------|----------|
| Workflow orchestrators | High | Medium | **P0** |
| Git automation | High | Low | **P0** |
| Research agents | High | High | **P1** |
| Code quality tools | Medium | Low | **P1** |
| Meta-tools | Medium | Medium | **P2** |
| Planning frameworks | Low | High | **P3** |

---

## Part 4: Transformation Recipes

### 4.1 Recipe: Passive Instruction → Tool Invocation

**Before:**
```markdown
Search the codebase for authentication-related files and review them for security issues.
```

**After:**
```markdown
## Authentication Security Review

### Step 1: Discovery
Grep("auth|login|session|token", path="src/", include="*.{ts,js}")

### Step 2: Analysis (Parallel)
FOR each discovered file:
  Task({
    subagent_type: "general-purpose",
    prompt: "Security audit {file}: Check for injection, improper auth, session issues"
  })

### Step 3: Synthesis
Aggregate findings → Structure as:
- Critical: [immediate action required]
- High: [fix before release]
- Medium: [address in next sprint]
```

### 4.2 Recipe: Embedded Docs → Skill Invocation

**Before:**
```markdown
# API Development Guide

When creating APIs, follow these conventions:
[200 lines of REST conventions]
[150 lines of error handling patterns]
[100 lines of validation rules]
...
```

**After:**
```markdown
# API Development Guide

## Context Loading
Skill("api-conventions") → Load when creating endpoints
Skill("error-handling") → Load when implementing error responses
Skill("validation-patterns") → Load when adding input validation

## Trigger Detection
IF prompt contains "endpoint" OR "route" OR "API":
  → Skill("api-conventions")
IF prompt contains "error" OR "exception" OR "failure":
  → Skill("error-handling")
```

### 4.3 Recipe: Sequential → Parallel Task Spawning

**Before:**
```markdown
1. First, analyze the frontend code
2. Then, analyze the backend code
3. Next, analyze the database schema
4. Finally, synthesize findings
```

**After:**
```markdown
## Parallel Analysis Phase
Execute simultaneously:
- Task("Analyze frontend: React components, state management, API calls")
- Task("Analyze backend: Express routes, middleware, business logic")
- Task("Analyze database: Schema design, indexes, relationships")

## Sequential Synthesis Phase
WAIT for all tasks to complete
Synthesize {frontend_result}, {backend_result}, {database_result}
Generate unified architecture report
```

### 4.4 Recipe: Static MCP → Dynamic Discovery

**Before:**
```markdown
Use the GitHub MCP server to list issues:
mcp__github__list_issues(repo="owner/repo")
```

**After:**
```markdown
## GitHub Integration

### Discovery Phase
IF GitHub operations needed:
  1. Check if mcp__github server connected (/mcp status)
  2. IF not connected → Fallback to `gh` CLI
  3. IF connected → Use tool search for specific capability

### Execution
PREFERRED: gh issue list --repo owner/repo --json number,title,state
FALLBACK: mcp__github__list_issues(repo="owner/repo")

### Output Handling
IF response > 10000 tokens:
  → Write to /tmp/github_issues.json
  → Skill("mcp-response-analyzer") to summarize
```

### 4.5 Recipe: Manual State → Hook-Based Enforcement

**Before:**
```markdown
Remember to run tests before committing.
Make sure to format code.
Don't forget to update documentation.
```

**After (settings.json):**
```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash(git commit)",
      "hooks": [{
        "type": "command",
        "command": "test -f /tmp/tests-passed || (echo 'Tests must pass first' && exit 2)"
      }]
    }],
    "PostToolUse": [{
      "matcher": "Edit|Write",
      "hooks": [{
        "type": "command",
        "command": "npx prettier --write \"$CLAUDE_FILE_PATH\""
      }]
    }]
  }
}
```

---

## Part 5: Architecture Recommendations

### 5.1 Plugin Modernizer Design

The Plugin Modernizer should be implemented as a **Skill with Agent capabilities**.

#### Recommended Architecture

```
.claude/skills/plugin-modernizer/
├── SKILL.md                    # Main skill definition
├── agents/
│   ├── auditor.md              # Audit scoring agent
│   ├── transformer.md          # Code transformation agent
│   └── validator.md            # Post-transform validation
├── templates/
│   ├── active-prompt.md        # Modern prompt template
│   ├── skill-loader.md         # Skill loading pattern
│   └── parallel-workflow.md    # Parallel execution pattern
└── scripts/
    ├── analyze.ts              # AST-based prompt analysis
    ├── score.ts                # Scoring calculation
    └── transform.ts            # Automated transformations
```

#### SKILL.md Structure

```markdown
---
name: plugin-modernizer
description: Audit and modernize Claude Code plugins for tool-active patterns
allowed-tools: Read, Write, Edit, Grep, Glob, Task, Skill
model: sonnet
---

# Plugin Modernizer

## When to Use
- "audit plugin", "modernize plugin", "check plugin score"
- "convert to active prompt", "add tool invocation"
- "optimize token usage", "add parallel execution"

## Workflow

### Phase 1: Discovery
Glob(".claude/commands/**/*.md") → Find all plugins
Glob(".claude/skills/**/*.md") → Include skills
Glob(".claude/agents/**/*.md") → Include agents

### Phase 2: Audit (Parallel)
FOR each plugin:
  Task(auditor): Score against 6 dimensions
  → Return: { file, scores, issues, recommendations }

### Phase 3: Report
Generate modernization report:
- Overall health score
- Priority-ordered fix list
- Estimated effort per fix

### Phase 4: Transform (On Request)
IF user approves transformation:
  Task(transformer): Apply transformation recipes
  Task(validator): Verify post-transform correctness
```

### 5.2 Integration Points

#### With Existing Plugin Workflows

```markdown
## Trigger Integration
Add to existing plugins:

IF /plugin-audit invoked:
  → Skill("plugin-modernizer")
  → Display audit results

IF /plugin-modernize invoked:
  → Skill("plugin-modernizer") with transform=true
  → Apply transformations
  → Show diff for approval
```

#### State Management

```markdown
## Caching Strategy
- Audit results → .claude/cache/plugin-audit.json (TTL: 24h)
- Transformation history → .claude/cache/transform-log.json
- Scoring baselines → CLAUDE.local.md (persistent)

## Repository Scoping
- All paths relative to repository root
- No global state modifications
- Results scoped to current project
```

### 5.3 Future-Proofing Considerations

Based on research into Claude Code's trajectory:

#### Near-Term (2026 Q1-Q2)
- **Tool Search Improvements**: Expect better semantic matching—design skills with rich descriptions
- **MCP Evolution**: OAuth, structured outputs, server-initiated requests—abstract MCP calls behind skills
- **Context Editing**: Built-in stale context cleanup—design for smaller, focused prompts

#### Medium-Term (2026 H2)
- **Cross-Model Orchestration**: Multi-LLM workflows—design agent contracts as model-agnostic
- **Reinforcement Learning Context**: Models managing their own context—reduce explicit context management
- **Background Agent Improvements**: Better async coordination—prepare for true parallelism

#### Design Principles for Longevity
1. **Skill-First**: Put all domain knowledge in skills, not prompts
2. **Tool-Agnostic**: Reference capabilities, not specific tool names
3. **Minimal Base**: Keep core prompts under 500 lines
4. **Explicit Contracts**: Define clear input/output structures
5. **Hook-Enforced**: Use hooks for deterministic behavior, not prompt instructions

---

## Part 6: Quick Reference

### 6.1 Token Budget Guidelines

| Component | Recommended Max | Notes |
|-----------|-----------------|-------|
| Base prompt | 500 lines | Excluding loaded skills |
| Skill content | 500 lines each | Defer to sub-files if larger |
| Skill metadata | ~50 tokens each | Name + description only |
| MCP tools (auto-loaded) | 10% of context | Tool search kicks in above |
| Subagent context | Isolated | Doesn't count toward main |

### 6.2 Anti-Patterns to Detect

| Anti-Pattern | Detection | Fix |
|--------------|-----------|-----|
| Hardcoded paths | `grep -E "\/[a-z]+\/[a-z]+" *.md` | Use Glob/variables |
| Embedded large docs | Lines > 200 in single block | Extract to Skill |
| Sequential when parallel | "then", "next", "after" chains | Fan-out Tasks |
| Global state | References to ~/.claude | Repository-scope |
| Assumed tool availability | Direct mcp__ calls | Discovery first |
| No error handling | Missing "if fails" | Add fallback paths |

### 6.3 Modernization Checklist (Quick)

```markdown
□ Tool Activity
  □ Explicit tool invocations present
  □ Parameters specified (not inferred)
  □ Conditional tool selection

□ Token Efficiency  
  □ Docs loaded via Skill(), not embedded
  □ Trigger keywords defined
  □ Verbose ops delegated to subagents

□ Parallelization
  □ Independent tasks use parallel Task()
  □ Fan-out/fan-in structure clear
  □ Synthesis phase defined

□ Task Management (v2.1.x)
  □ Use TaskCreate for multi-step coordination
  □ TaskUpdate for status/dependencies
  □ addBlocks/addBlockedBy for dependency graphs
  □ TaskOutput for retrieving background results
  □ TaskStop for cleanup
  □ CLAUDE_CODE_TASK_LIST_ID for persistence

□ MCP Integration
  □ Dynamic discovery, not hardcoded
  □ Output filtering/summarization
  □ Fallback to CLI when available

□ Error Handling
  □ Failure cases addressed
  □ Fallback strategies defined
  □ Partial completion handled

□ State Management
  □ Repository-scoped (not global)
  □ Session boundaries clear
  □ Persistent state in CLAUDE.local.md
```

---

## Part 7: Multi-Agent Orchestration Architecture (January 2026)

### 7.1 Current State of Multi-Agent Support

Claude Code v2.1.x contains hidden infrastructure for full multi-agent orchestration. While TeammateTool is feature-flagged, the underlying primitives are available:

| Capability | Current Status | Workaround |
|------------|----------------|------------|
| Task spawning (Task tool) | ✅ Available | - |
| Background execution | ✅ Available | `run_in_background: true` |
| Task dependencies | ✅ Available | `blocks`/`blockedBy` in TaskCreate |
| Persistent task state | ✅ Available | `~/.claude/tasks/{session-id}/` |
| Team discovery | ⚠️ Feature-flagged | File-based state |
| Inter-agent messaging | ⚠️ Feature-flagged | Shared files |
| Leader election | ❌ Not implemented | Manual orchestration |

### 7.2 Multi-Agent Orchestration Patterns

#### Pattern 1: Simple Subagent (No Tracking)

```javascript
Task(subagent_type: "Explore", prompt: "Find auth files")
```

#### Pattern 2: Tracked Subagent

```javascript
// 1. Create tracking entry
TaskCreate(subject: "EXPLORE: auth", description: "Find authentication patterns")  
// → id: "1"

// 2. Spawn worker
Task(subagent_type: "Explore", prompt: "Find auth files")

// 3. Update tracking on completion
TaskUpdate(taskId: "1", status: "completed")
```

#### Pattern 3: Parallel with Dependencies

```javascript
// Create tasks with dependency graph
TaskCreate(subject: "Backend API", ...)           // → id: "1"
TaskCreate(subject: "Frontend UI", ...)           // → id: "2"
TaskUpdate(taskId: "2", addBlockedBy: ["1"])      // UI waits for API

TaskCreate(subject: "Integration tests", ...)     // → id: "3"
TaskUpdate(taskId: "3", addBlockedBy: ["1", "2"]) // Tests wait for both

// Agents claim and execute in dependency order
```

#### Pattern 4: Background Execution with Output Retrieval

```javascript
// Launch background agent
Task({
  subagent_type: "Explore", 
  prompt: "Find all auth files",
  run_in_background: true
})  // → task_id: "bg-abc123"

// Continue other work...

// Retrieve results when ready
TaskOutput({
  task_id: "bg-abc123", 
  block: true,          // Wait for completion
  timeout: 60000        // Max 60 seconds
})
```

#### Pattern 5: Fan-Out Review with Coordination

```markdown
## Workflow: Parallel Code Review

### Setup
TaskCreate(subject="PR Review Orchestration", description="Coordinate review team")

### Fan-Out (parallel background agents)
Task("security-audit", prompt="Review for vulnerabilities", run_in_background=true) → task_id_1
Task("performance-check", prompt="Identify N+1 queries", run_in_background=true) → task_id_2
Task("style-compliance", prompt="Check ESLint rules", run_in_background=true) → task_id_3

### Collect Results
TaskOutput(task_id: task_id_1, block: true)
TaskOutput(task_id: task_id_2, block: true)
TaskOutput(task_id: task_id_3, block: true)

### Synthesis
Aggregate findings → Generate report
```

#### Pattern 6: Pipeline with Persistent Task List

```bash
# Terminal 1: Set shared task list
export CLAUDE_CODE_TASK_LIST_ID=feature-sprint-2026

# Terminal 2: Same shared task list
export CLAUDE_CODE_TASK_LIST_ID=feature-sprint-2026

# Both terminals share the same task list in:
# ~/.claude/tasks/feature-sprint-2026/
```

### 7.3 File-Based Team Coordination (Until TeammateTool is Enabled)

```javascript
// Create team state file
Write(".claude/team-state.json", JSON.stringify({
  team: "feature-sprint",
  leader: "orchestrator",
  agents: [],
  tasks: [],
  messages: []
}))

// Agents register themselves
Task({
  prompt: `
    1. Read .claude/team-state.json
    2. Add yourself to agents array with ID
    3. Find unclaimed task matching your specialty
    4. Claim it by setting owner field
    5. Execute task
    6. Update status to completed
    7. Check for messages to you in messages array
  `,
  run_in_background: true
})
```

### 7.4 Third-Party Orchestration Frameworks

Several community frameworks unlock Claude Code's hidden capabilities:

| Framework | Key Features | URL |
|-----------|--------------|-----|
| **CC Mirror** | Unlocks TaskCreate/Update, file-based teams | github.com/numman-ali/cc-mirror |
| **Claude Flow** | SQLite state, consensus algorithms, 50+ agents | github.com/ruvnet/claude-flow |
| **ccswarm** | Git worktree isolation per agent | github.com/nwiizo/ccswarm |
| **Agentrooms** | @mentions routing between agents | github.com/baryhuang/claude-code-by-agents |
| **oh-my-claudecode** | 28 agents, HUD statusline, research workflow | github.com/Yeachan-Heo/oh-my-claudecode |

### 7.5 Future-Proofing for TeammateTool

When TeammateTool becomes generally available, plugins should be ready:

```markdown
## Multi-Agent Ready Plugin Template
---
allowed-tools: Task, TaskCreate, TaskList, TeammateTool
---

### IF TeammateTool available:
  TeammateTool(operation="spawnTeam", name="code-review-team")
  TeammateTool(operation="write", agent_id="security-expert", message="Begin audit")

### ELSE (fallback):
  Task(prompt="...", run_in_background=true)
  Shared state via .claude/team-state.json
```

---

## Appendices

### Appendix A: Tool Parameter Reference

See: [Piebald-AI/claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts) for complete tool descriptions

### Appendix B: Hook Event Types

| Event | When Fired | Can Block |
|-------|------------|-----------|
| UserPromptSubmit | Before prompt processing | Yes (exit 2) |
| PreToolUse | Before tool execution | Yes (exit 2) |
| PostToolUse | After successful tool | No |
| PostToolUseFailure | After tool failure | No |
| PermissionRequest | Permission dialog shown | Yes |
| Notification | Claude sends alert | No |
| Stop | Response complete | No |
| SubagentStart | Subagent begins execution | No |
| SubagentStop | Subagent finishes | Yes (exit 2) |
| SessionStart | Session begins/resumes | No |
| SessionEnd | Session terminates | No |
| PreCompact | Before context compaction | No |

### Appendix C: Research Sources

**Official Documentation:**
1. Claude Code Docs: https://code.claude.com/docs/
2. Claude Agent SDK: https://platform.claude.com/docs/en/agent-sdk/overview
3. Claude Code GitHub: https://github.com/anthropics/claude-code

**System Prompts & Architecture:**
4. System Prompts Archive: https://github.com/Piebald-AI/claude-code-system-prompts
5. Multi-Agent Feature Analysis: https://gist.github.com/kieranklaassen/d2b35569be2c7f1412c64861a219d51f

**Anthropic Engineering:**
6. Advanced Tool Use: https://www.anthropic.com/engineering/advanced-tool-use
7. Claude Code Best Practices: https://www.anthropic.com/engineering/claude-code-best-practices
8. Building Agents with Agent SDK: https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk

**Community Resources:**
9. Awesome Claude Code: https://github.com/hesreallyhim/awesome-claude-code
10. CC Mirror (multi-agent unlock): https://github.com/numman-ali/cc-mirror
11. Claude Flow (orchestration): https://github.com/ruvnet/claude-flow
12. oh-my-claudecode: https://github.com/Yeachan-Heo/oh-my-claudecode

---

*Report generated: January 24, 2026*  
*Claude Code versions referenced: v2.0.56 - v2.1.19*  
*Verified against Claude Code v2.1.19 direct system query*
