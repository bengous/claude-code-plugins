---
description: Trace and visualize the execution flow of a Claude Code command, skill, or agent workflow
argument-hint: <command-name, skill-name, file-path, or workflow description>
allowed-tools:
  - Read
  - Glob
  - Grep
  - WebSearch
  - WebFetch
  - mcp__*
---

# Workflow Trace

**Target:** $ARGUMENTS

## Your Task

Trace the complete execution flow of the target and produce ASCII workflow diagrams showing every step from user input to final output.

This is NOT a concept explanation. Do NOT explain what the target "is" or "why it exists." Instead, trace what HAPPENS -- step by step -- when it executes.

## Step 1: Resolve the Target

Determine what kind of target was provided:

**Plugin component** (command, skill, agent, hook):
- Search for matching `.md` files in commands/, skills/, agents/, hooks/ directories across all plugins
- Use Glob: `**/commands/$ARGUMENTS.md`, `**/commands/$ARGUMENTS/*.md`, `**/skills/$ARGUMENTS/SKILL.md`, `**/agents/$ARGUMENTS.md`
- If target contains `:`, split on `:` as `plugin:component` (e.g., `orchestration:orc` -> `orchestration/commands/orc.md`)

**File path**:
- If target contains `/` or ends in `.md`, `.sh`, `.py`, `.ts`, `.js`, treat as a direct file path and Read it
- The file may be a command, skill, agent definition, OR a plan/design document that describes a Claude Code agent workflow
- In all cases, extract the Claude Code components (commands, skills, agents, tools, hooks) described or referenced in the file

**Workflow description**:
- If neither above matches, Grep the codebase for relevant keywords
- Identify the primary entry point(s) that match the description

## Step 2: Trace the Execution Path

Starting from the resolved file(s), systematically trace the Claude Code agent workflow.

**If the target is a plan or design document** that describes an agent workflow (rather than being an executable command/skill itself): extract the Claude Code components it references -- commands invoked, agents spawned, skills used, tools called, hooks involved -- then trace each component by reading its source file. The plan describes the intended flow; the component files contain the actual implementation to trace.

For each file in the workflow, identify:

1. **Entry point**: What triggers this? (slash command, agent spawn, hook event, function call)
2. **Argument handling**: How are inputs parsed or interpreted?
3. **Sequential steps**: Walk through the instructions/code in order
4. **Tool calls**: What tools does it invoke? (Read, Glob, Grep, Bash, Task, Write, Edit, AskUserQuestion, Skill, etc.)
5. **Decision branches**: Where does flow split? What conditions determine the path?
6. **Delegations**: Does it spawn sub-agents (Task tool)? If so:
   - Read the agent definition file
   - Trace the agent's own execution path
   - Note what the agent returns
7. **Script executions**: Does it call external scripts? If so:
   - Read the script file
   - Trace the script's logic
8. **Skill invocations**: Does it invoke skills (Skill tool)? If so:
   - Read the SKILL.md
   - Summarize the skill's workflow steps
9. **Hook triggers**: Are there hooks that fire during this workflow?
   - Search for hook definitions that match relevant events
10. **Data flow**: What data is passed between steps? (files written, variables, piped output)
11. **User interaction points**: Where does it stop and ask the user? (AskUserQuestion, approval gates)
12. **Terminal state**: What does the user see when it finishes?

For each delegation (agent, script, skill), follow into the source file and trace its path too. Do not stop at the boundary.

## Step 3: Create the Workflow Diagram

Produce ONE primary flow diagram showing the complete execution lifecycle. For workflows with sub-agents, add a SECOND sequence diagram showing agent interactions.

### Primary Flow Diagram

Show the linear/branching execution path:

```text
┌──────────────────────┐
│ User: /command args  │
└──────────┬───────────┘
           ▼
   ┌───────────────┐
   │ Parse input   │
   └───────┬───────┘
           ▼
   ┌───────────────┐    Yes   ┌────────────────┐
   │  Condition?   │────────▶│ Branch A       │
   └───────┬───────┘         └────────┬───────┘
           │ No                       │
           ▼                          │
   ┌───────────────┐                  │
   │ Branch B      │                  │
   └───────┬───────┘                  │
           │◀─────────────────────────┘
           ▼
   ┌───────────────┐
   │ Output result │
   └───────────────┘
```

### Sequence Diagram (for multi-agent workflows)

Show agent spawning and communication:

```text
User          Command        Agent-1        Agent-2
 │               │              │              │
 │── /command ──▶│              │              │
 │               │── spawn ────▶│              │
 │               │── spawn ───────────────────▶│
 │               │              │── work ──▶   │
 │               │              │◀── done ──   │
 │               │◀── result ───│              │
 │               │◀── result ──────────────────│
 │◀── output ────│              │              │
```

## Step 4: Annotate the Diagram

Below the diagram(s), provide a numbered walkthrough:

1. **[Step name]** - What happens, which file/line drives it
   - Tool: `[tool name]` called with `[key args]`
   - File: `path/to/relevant-file.md:line`
2. **[Step name]** - ...

Include `file:line` references for every step so the user can navigate to the source.

## Diagram Guidelines

- Use box-drawing characters: `─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼`
- Use arrows: `▶ ◀ ▲ ▼ ──▶ ◀──`
- Keep width under 80 characters
- Label ALL boxes with the actual step name or tool name
- Mark decision points clearly with Yes/No or condition labels
- Mark user interaction points with `[USER]`
- Mark agent spawns with `──▶ [AGENT: name]`
- Mark script executions with `──▶ [SCRIPT: name]`
- Use `...` to collapse repetitive parallel patterns

## Output Format

```markdown
## Workflow: [target name]

**Entry:** [how it starts]
**Exit:** [what the user gets]
**Components:** [count of files involved]

### Execution Flow
[Primary flow diagram]

### Agent Interactions
[Sequence diagram -- omit section if no agents]

### Step-by-Step Trace
1. [Step] - [description] (`file:line`)
2. ...

### Key Files
| File | Role in Workflow |
|------|-----------------|
| path/to/file | [what it does] |
```

## Anti-Patterns

- Do NOT explain what the component "is" conceptually -- trace what it DOES
- Do NOT include architecture diagrams -- only execution flow
- Do NOT skip sub-agent tracing -- follow delegations to their source files
- Do NOT invent steps not present in the code -- trace only what exists
- Do NOT produce a wall of text -- the diagram is the primary output
