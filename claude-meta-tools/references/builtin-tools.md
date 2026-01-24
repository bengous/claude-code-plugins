# Claude Code Built-in Tools Reference

**Last verified:** 2026-01-24
**Model:** claude-opus-4-5-20251101
**Source:** Direct system prompt observation

---

## File Operations

### Read

Read file contents from the filesystem.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | Yes | Absolute path to the file |
| `offset` | number | No | Line number to start reading from |
| `limit` | number | No | Number of lines to read |

**Notes:**
- Default reads up to 2000 lines from beginning
- Lines longer than 2000 chars are truncated
- Can read images (PNG, JPG), PDFs, and Jupyter notebooks
- Results use `cat -n` format with line numbers starting at 1

### Write

Create or overwrite files.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | Yes | Absolute path to the file |
| `content` | string | Yes | Content to write |

**Notes:**
- Overwrites existing files
- Must Read file first before overwriting existing files

### Edit

Perform exact string replacements in files.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | Yes | Absolute path to the file |
| `old_string` | string | Yes | Text to replace |
| `new_string` | string | Yes | Replacement text |
| `replace_all` | boolean | No | Replace all occurrences (default: false) |

**Notes:**
- Fails if `old_string` is not unique (unless `replace_all: true`)
- Must Read file first before editing

### Glob

Fast file pattern matching.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | Yes | Glob pattern (e.g., `**/*.ts`) |
| `path` | string | No | Directory to search in (default: cwd) |

**Notes:**
- Returns files sorted by modification time

### Grep

Content search using ripgrep.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | Yes | Regex pattern to search |
| `path` | string | No | File or directory to search |
| `glob` | string | No | Glob pattern to filter files |
| `type` | string | No | File type (js, py, rust, go, etc.) |
| `output_mode` | string | No | `content`, `files_with_matches` (default), or `count` |
| `-A` | number | No | Lines after match |
| `-B` | number | No | Lines before match |
| `-C` | number | No | Lines before and after match |
| `-i` | boolean | No | Case insensitive |
| `-n` | boolean | No | Show line numbers (default: true) |
| `multiline` | boolean | No | Enable multiline matching |
| `head_limit` | number | No | Limit output entries |
| `offset` | number | No | Skip first N entries |

---

## Execution

### Bash

Execute shell commands.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | Command to execute |
| `description` | string | No | Description of what command does |
| `timeout` | number | No | Timeout in ms (max: 600000, default: 120000) |
| `run_in_background` | boolean | No | Run in background |
| `dangerouslyDisableSandbox` | boolean | No | Override sandbox mode |

**Notes:**
- Working directory persists between commands
- Shell state (env vars, etc.) does not persist
- Use `&&` to chain dependent commands
- Prefer dedicated tools over bash for file operations

### Task

Launch subagents for complex tasks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `subagent_type` | string | Yes | Agent type (see below) |
| `prompt` | string | Yes | Task instructions |
| `description` | string | Yes | 3-5 word summary |
| `run_in_background` | boolean | No | Non-blocking execution |
| `resume` | string | No | Agent ID to resume |
| `allowed_tools` | array | No | Tools to grant (e.g., `["Bash(git *)"]`) |
| `max_turns` | number | No | Max API round-trips |
| `model` | string | No | `sonnet`, `opus`, or `haiku` |

**Subagent Types:**

| Type | Tools Available |
|------|-----------------|
| `Bash` | Bash only |
| `general-purpose` | All tools |
| `Explore` | All except Task, ExitPlanMode, Edit, Write, NotebookEdit |
| `Plan` | All except Task, ExitPlanMode, Edit, Write, NotebookEdit |
| `statusline-setup` | Read, Edit |
| `claude-code-guide` | Glob, Grep, Read, WebFetch, WebSearch |

---

## Task Management

### TaskCreate

Create a task in the session's task list.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `subject` | string | Yes | Brief title (imperative form) |
| `description` | string | Yes | Detailed requirements |
| `activeForm` | string | No | Spinner text when in progress |
| `metadata` | object | No | Arbitrary key-value pairs |

**Returns:** `{ taskId: string }`

### TaskUpdate

Modify task status, dependencies, and metadata.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID |
| `status` | string | No | `pending`, `in_progress`, or `completed` |
| `subject` | string | No | New title |
| `description` | string | No | New description |
| `activeForm` | string | No | New spinner text |
| `owner` | string | No | Agent ID to assign |
| `metadata` | object | No | Metadata to merge (null deletes key) |
| `addBlocks` | array | No | Task IDs this blocks |
| `addBlockedBy` | array | No | Task IDs blocking this |

### TaskGet

Retrieve full task details.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID |

**Returns:** Full task object with blocks/blockedBy arrays.

### TaskList

List all tasks in the session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | | | |

**Returns:** Array of task summaries.

### TaskOutput

Get output from background tasks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | Yes | Background task ID |
| `block` | boolean | No | Wait for completion (default: true) |
| `timeout` | number | No | Max wait in ms (default: 30000, max: 600000) |

### TaskStop

Terminate a running background task.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | Yes | Task ID to stop |

---

## Planning

### EnterPlanMode

Enter planning mode for non-trivial implementations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | | | |

**Notes:**
- Requires user approval to enter
- Use for new features, architectural decisions, multi-file changes

### ExitPlanMode

Present plan for user approval.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `allowedPrompts` | array | No | Permission prompts needed for implementation |
| `pushToRemote` | boolean | No | Push plan to remote session |

---

## Web

### WebSearch

Search the web.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query |
| `allowed_domains` | array | No | Only include these domains |
| `blocked_domains` | array | No | Exclude these domains |

**Notes:**
- Must include Sources section with URLs in response

### WebFetch

Fetch and process URL content.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | URL to fetch |
| `prompt` | string | Yes | What to extract from the page |

**Notes:**
- Cannot access authenticated pages
- HTTP upgraded to HTTPS
- 15-minute cache

---

## Interaction

### AskUserQuestion

Ask user questions during execution.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `questions` | array | Yes | 1-4 questions |
| `questions[].question` | string | Yes | The question text |
| `questions[].header` | string | Yes | Short label (max 12 chars) |
| `questions[].options` | array | Yes | 2-4 options |
| `questions[].options[].label` | string | Yes | Display text |
| `questions[].options[].description` | string | Yes | Explanation |
| `questions[].multiSelect` | boolean | Yes | Allow multiple selections |

**Notes:**
- "Other" option auto-added for custom input

### Skill

Execute a skill.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `skill` | string | Yes | Skill name (e.g., `commit`, `git-tools:issue`) |
| `args` | string | No | Arguments for the skill |

---

## Other Tools

### NotebookEdit

Edit Jupyter notebook cells.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `notebook_path` | string | Yes | Absolute path to .ipynb |
| `new_source` | string | Yes | New cell content |
| `cell_id` | string | No | Cell ID to edit |
| `cell_type` | string | No | `code` or `markdown` |
| `edit_mode` | string | No | `replace`, `insert`, or `delete` |

### ToolSearch

Load deferred MCP tools.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search or `select:<tool_name>` |
| `max_results` | number | No | Max results (default: 5) |

**Notes:**
- Must load deferred tools before calling them
- Keyword search loads returned tools automatically

### ListMcpResourcesTool

List MCP server resources.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `server` | string | No | Filter by server name |

### ReadMcpResourceTool

Read an MCP resource.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `server` | string | Yes | MCP server name |
| `uri` | string | Yes | Resource URI |

---

## Tools That DO NOT Exist

The following are sometimes referenced but are **not available**:

| Tool | Status |
|------|--------|
| `TodoWrite` | Does not exist |
| `SlashCommand` | Does not exist |
| `TeammateTool` | Does not exist (possibly feature-flagged) |

---

## Deferred Tools (require ToolSearch to load)

```
mcp__Context7__resolve-library-id
mcp__Context7__query-docs
mcp__MCP_DOCKER__code-mode
mcp__MCP_DOCKER__mcp-add
mcp__MCP_DOCKER__mcp-config-set
mcp__MCP_DOCKER__mcp-exec
mcp__MCP_DOCKER__mcp-find
mcp__MCP_DOCKER__mcp-remove
mcp__bun__SearchBun
```
