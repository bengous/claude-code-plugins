# Hook Lifecycle: Plan Acceptance Flows

> Empirical investigation of Claude Code hook behavior during plan mode acceptance.
> Tested on Claude Code v2.1.66–v2.1.72, March 11, 2026.

## Table of contents

- [The problem](#the-problem)
- [Initial research and hypotheses](#initial-research-and-hypotheses)
- [Why we chose empirical testing over trusting docs](#why-we-chose-empirical-testing-over-trusting-docs)
- [Hook diagnostic methodology](#hook-diagnostic-methodology)
- [Test protocol and results](#test-protocol-and-results)
- [What the tests revealed](#what-the-tests-revealed)
- [The solution](#the-solution)
- [Regression testing](#regression-testing)
- [Reference: transcript JSONL structure](#reference-transcript-jsonl-structure)
- [Reference: hook stdin JSON payloads](#reference-hook-stdin-json-payloads)
- [Reference: discrepancies with official documentation](#reference-discrepancies-with-official-documentation)

---

## The problem

We have an `archive-plan` hook (`PostToolUse[ExitPlanMode]` at `~/.local/bin/archive-plan`) that archives accepted plans to the git repo under `$cwd/plans/YYYY-MM-DD/<slug>.md`. It works when the user accepts a plan **in the same session** (default Enter).

But when the user chooses **"Accept and reset context"** (Shift+Tab / option 1), the plan is never archived. The user loses traceability — the plan that drove the implementation isn't saved alongside the code.

The question: **what hooks fire during "Accept and reset context", and how can we hook into them?**

---

## Initial research and hypotheses

### What we knew from reading transcripts

Before any testing, we analyzed existing transcript files in `~/.claude/projects/` to understand the data format:

- Each session produces a `.jsonl` file (one JSON object per line)
- When "Accept and reset context" is used, the new session's transcript contains a `planContent` field on the first user message
- We confirmed this pattern across 10+ sessions in the IdeAs project by grepping for `"planContent"` in `.jsonl` files
- All plan-injected sessions had `SessionStart:clear` in their progress entries (visible in transcript `data.hookName` field)

### Hypothesis 1: Background daemon from SessionStart (initial approach)

Our first design was a SessionStart hook that would:
1. Detect `source: "clear"` (indicating a context reset)
2. Fork a background daemon (`setsid`) that polls the transcript every 0.5s
3. Wait for the `planContent` message to appear (timing constraint: planContent is written AFTER hooks complete)
4. Archive it

**Why this was our first idea**: We knew from transcript analysis that planContent appears after the SessionStart hook progress entries. The hook runs before the plan is in the transcript, so synchronous reading is impossible. A background daemon was the only way to bridge this gap.

**Problems with this approach**:
- Polling is inherently fragile (what if the plan takes longer to appear?)
- Background process can't return `additionalContext` to Claude
- Added complexity with `setsid`, `disown`, process management
- No way to confirm to the user that archival succeeded

### Hypothesis 2: SessionEnd might be better

The user suggested investigating the `SessionEnd` hook. We didn't initially consider it because:
- Research found GitHub issues (#6428, #20900) suggesting SessionEnd doesn't fire reliably
- Issue #30217 reported that `transcript_path` might be deleted before the hook reads it
- The reference doc (Jan 2026) said SessionEnd has no matcher support

But these were all second-hand findings from docs and issues — not empirical observations. The user's instinct was to test it.

### The decision to test empirically

Rather than choosing between hypotheses based on uncertain documentation, we decided to **instrument all three hooks** (SessionStart, SessionEnd, ExitPlanMode) and observe the actual behavior in controlled scenarios. This turned out to be the right call — the docs were wrong on multiple points.

---

## Why we chose empirical testing over trusting docs

The official Claude Code hooks documentation has known gaps:

| What docs/issues say | What we found |
|----------------------|---------------|
| SessionEnd may not fire on /clear (#6428) | **It fires reliably** |
| transcript_path may be deleted at SessionEnd (#30217) | **It exists and is readable** in all our tests |
| SessionEnd has no matcher support (reference doc Jan 2026) | The `reason` field exists and is populated |
| No docs for "Accept and reset context" hook sequence | We documented it from scratch |
| SessionStart receives `model` field | Only on `source: "startup"`, **missing on `source: "clear"`** |

**Lesson learned**: For hooks, trust empirical testing over documentation. The internals change faster than the docs are updated, and edge cases (like plan acceptance) are rarely documented.

---

## Hook diagnostic methodology

This methodology is reusable for investigating any hook behavior.

### 1. Create the diagnostic script

A single reusable script `~/.local/bin/hook-logger` that takes the event name as `$1` and logs everything to `/tmp/claude-hook-diagnostic.log`:

```bash
#!/usr/bin/env bash
set -euo pipefail

EVENT="$1"  # passed as argument: SessionStart, SessionEnd, ExitPlanMode, etc.
LOG="/tmp/claude-hook-diagnostic.log"
input=$(cat)

echo "===== $EVENT at $(date -Iseconds) =====" >> "$LOG"
echo "$input" | jq '.' >> "$LOG" 2>&1 || echo "$input" >> "$LOG"

# Log transcript state (critical for timing analysis)
transcript=$(echo "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
if [[ -n "$transcript" ]]; then
  echo "--- transcript_path exists: $(test -f "$transcript" && echo YES || echo NO)" >> "$LOG"
  if [[ -f "$transcript" ]]; then
    echo "--- transcript lines: $(wc -l < "$transcript")" >> "$LOG"
    echo "--- first 3 lines:" >> "$LOG"
    head -3 "$transcript" | jq -c '{type, has_plan: (has("planContent") and (.planContent | length) > 0)}' >> "$LOG" 2>&1 || true
    plan_count=$(jq -r 'select(.planContent != null) | .planContent' "$transcript" 2>/dev/null | head -1 | wc -c)
    echo "--- planContent bytes in transcript: $plan_count" >> "$LOG"
  fi
fi

echo "" >> "$LOG"
exit 0
```

**Design choice**: A single script with `$1` argument rather than one script per event. The command in settings.json becomes `~/.local/bin/hook-logger SessionStart`. This keeps the diagnostic infrastructure to one file — easy to deploy and remove.

**What we log**: The full stdin JSON (to discover undocumented fields), transcript file existence (timing analysis), line count (session maturity), and planContent presence (plan detection). This covers all the unknowns we need to resolve.

### 2. Register diagnostic hooks in settings.json

Add alongside (not replacing) existing hooks:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [
      { "type": "command", "command": "~/.local/bin/hook-logger SessionStart", "timeout": 5 }
    ]}],
    "SessionEnd": [{ "hooks": [
      { "type": "command", "command": "~/.local/bin/hook-logger SessionEnd", "timeout": 5 }
    ]}],
    "PostToolUse": [{ "matcher": "ExitPlanMode", "hooks": [
      { "type": "command", "command": "~/.local/bin/hook-logger ExitPlanMode", "timeout": 5 }
    ]}]
  }
}
```

**Important**: Add the logger as an additional hook entry, not a replacement. Existing hooks continue to function during testing.

### 3. Create a disposable test repo

```bash
mkdir -p /tmp/hook-test && cd /tmp/hook-test
git init && echo "# test" > README.md && git add . && git commit -m "init"
```

**Why a disposable repo**: Tests may create files (plans, archives). A throwaway repo avoids polluting real projects and makes cleanup trivial.

### 4. Clear the log and run tests

```bash
> /tmp/claude-hook-diagnostic.log
cd /tmp/hook-test && claude
```

After each test: `cat /tmp/claude-hook-diagnostic.log`

### 5. Extend to other events

This methodology works for any hook event. To investigate `Stop`, `SubagentStop`, `PreToolUse`, etc., just add more `hook-logger <EventName>` entries to settings.json. The script handles any event generically.

---

## Test protocol and results

We ran 3 controlled tests, each in a fresh `claude` session from `/tmp/claude-hook-test`.

### Test 1 — Accept sans reset (baseline)

**Action**: `/plan Cree un fichier hello.txt avec "Hello World" dedans` → Accept (Enter) → /exit

**Purpose**: Establish baseline — what happens when the existing `archive-plan` hook works correctly.

**Observed event sequence**:
```
14:11:12  SessionStart    session=3807d9bd  source="startup"     transcript=NO
14:11:55  ExitPlanMode    session=3807d9bd  tool_response.plan=✓  transcript=YES (21 lines)
14:11:56  SessionStart    session=2213e207  source="startup"     transcript=NO
14:12:02  SessionEnd      session=2213e207  reason="other"       transcript=NO
```

**Findings**:
1. **ExitPlanMode fires as PostToolUse** — `tool_response` contains the full plan content, the plan file path (`~/.claude/plans/<name>.md`), and metadata (`isAgent`, `hasTaskTool`)
2. **A new session starts immediately** after ExitPlanMode — different session ID, `source: "startup"`. Plan acceptance always creates a new session, even without "reset context".
3. **No SessionEnd fires for the planning session** — session `3807d9bd` transitions silently. Only the implementation session gets a SessionEnd (when the user exits).
4. **Transcript doesn't exist when SessionStart fires** — confirmed `transcript_path exists: NO`

### Test 2 — Accept and reset context (the target case)

**Action**: `/plan Cree un fichier goodbye.txt avec "Goodbye World" dedans` → Accept and reset context (Shift+Tab) → /exit

**Purpose**: Observe what hooks fire when the plan acceptance resets context — the flow where `archive-plan` fails.

**Observed event sequence**:
```
14:14:15  SessionStart    session=eb85a389  source="startup"     transcript=NO
14:14:40  SessionEnd      session=eb85a389  reason="clear"       transcript=YES (16 lines)
14:14:40  SessionStart    session=064ec0ca  source="clear"       transcript=NO
   ...    (Claude implements the plan)
14:15:29  SessionEnd      session=064ec0ca  reason="prompt_input_exit"  transcript=YES (21 lines, planContent=27 bytes)
```

**Findings**:
1. **ExitPlanMode is called but REJECTED** — Claude calls `ExitPlanMode` as a tool_use, but the user's "Accept and reset context" causes it to be rejected. The transcript contains: `"The user doesn't want to proceed with this tool use"`. Since **PostToolUse only fires on successful tool execution**, `archive-plan` never runs. This is the root cause of the original problem.
2. **SessionEnd fires** for the planning session with `reason: "clear"` — and crucially, **the transcript exists and is readable** (16 lines). This contradicts GitHub issue #30217.
3. **SessionStart fires** for the implementation session with `source: "clear"` — transcript does NOT exist yet (timing constraint confirmed).
4. **planContent appears in the implementation session's transcript** (27 bytes) — but only at the end, when SessionEnd fires for that session. Not available at SessionStart time.
5. **No `model` field** in SessionStart when `source: "clear"` (only present on `source: "startup"`).

### Test 3 — /clear simple (control)

**Action**: `/clear` → /exit

**Purpose**: Ensure we can distinguish "Accept and reset context" from a regular `/clear`, since both produce `reason: "clear"`.

**Observed event sequence**:
```
14:19:16  SessionEnd      session=4b1689b9  reason="clear"       transcript=YES (5 lines)
14:19:16  SessionStart    session=c8b3dc89  source="clear"       transcript=NO
14:19:19  SessionEnd      session=c8b3dc89  reason="prompt_input_exit"  transcript=YES (12 lines, planContent=0)
```

**Findings**:
1. SessionEnd fires with `reason: "clear"` — **same as Test 2**. The `reason` alone cannot distinguish plan-clear from regular /clear.
2. The transcript is very short (5 lines) and **contains no ExitPlanMode tool_use** — this is the key discriminant.

---

## What the tests revealed

### The discriminant

| Scenario | SessionEnd reason | ExitPlanMode in transcript? | PostToolUse fires? |
|----------|------------------|-----------------------------|--------------------|
| Accept (same session) | *(no SessionEnd for plan session)* | N/A — tool completes | **Yes** |
| Accept + reset | `"clear"` | **Yes** (tool rejected) | **No** |
| /clear (no plan) | `"clear"` | **No** | N/A |

**Detection logic**: When SessionEnd fires with `reason: "clear"`, grep the transcript for `"ExitPlanMode"`. Present → plan was being accepted, archive it. Absent → regular /clear, skip.

### Why our initial hypothesis was wrong

The background daemon approach from SessionStart was unnecessary. We designed it because:
1. We assumed SessionEnd might not fire (docs said so)
2. We knew the transcript doesn't exist at SessionStart time

But empirical testing showed SessionEnd **does fire reliably**, and the transcript **is readable** at that point. The synchronous SessionEnd approach is simpler, more reliable, and deterministic.

### How to locate the plan at SessionEnd time

The plan content is NOT in the planning session's transcript as `planContent` (that field only exists in the implementation session). But we have two sources:

1. **The plan file in `~/.claude/plans/`** — created during plan mode, still exists at SessionEnd time. The most recently modified `.md` file (within the last 2 minutes) is the plan being accepted.
2. **The ExitPlanMode tool_use in the transcript** — Claude called ExitPlanMode (even though rejected), and the tool input may reference the plan.

We chose source 1 (plan file) because it's simpler and contains the exact content Claude wrote.

---

## The solution

### Two complementary hooks

| Hook | Event | Script | Catches |
|------|-------|--------|---------|
| `PostToolUse[ExitPlanMode]` | Plan accepted in same session | `~/.local/bin/archive-plan` | Uses `tool_response.plan` directly. Calls Haiku for descriptive naming. Has cross-project routing. |
| `SessionEnd` | Plan accepted with reset context | `~/.local/bin/archive-plan-on-clear` | Detects `ExitPlanMode` in transcript. Reads plan from `~/.claude/plans/`. Uses slug naming. |

These two hooks are **mutually exclusive** — ExitPlanMode either completes (PostToolUse fires) or is rejected (SessionEnd fires with reason="clear"). They never both fire for the same plan acceptance.

### archive-plan-on-clear — the new hook

```bash
#!/usr/bin/env bash
set -euo pipefail

# SessionEnd hook — archives plans when "Accept and reset context" is used.
#
# Why: "Accept and reset context" rejects the ExitPlanMode tool_use and does
# a session clear. PostToolUse/ExitPlanMode never fires. This hook catches
# the SessionEnd(reason="clear") event instead.
#
# Detection: grep transcript for "ExitPlanMode" — present = plan-clear,
# absent = regular /clear.

input=$(cat)
reason=$(echo "$input" | jq -r '.reason // empty')
transcript_path=$(echo "$input" | jq -r '.transcript_path // empty')
json_cwd=$(echo "$input" | jq -r '.cwd // empty')
cwd="${CLAUDE_PROJECT_DIR:-$json_cwd}"

# Guard: only act on "clear" reason
[[ "$reason" == "clear" ]] || exit 0
[[ -n "$transcript_path" && -n "$cwd" ]] || exit 0

# Guard: cwd must be a git repo
git -C "$cwd" rev-parse --is-inside-work-tree &>/dev/null || exit 0

# Guard: transcript must contain ExitPlanMode (distinguishes plan-clear from /clear)
[[ -f "$transcript_path" ]] || exit 0
grep -q '"ExitPlanMode"' "$transcript_path" || exit 0

# Find the most recently modified plan file (< 2 minutes old)
plans_dir="$HOME/.claude/plans"
[[ -d "$plans_dir" ]] || exit 0
latest_plan=$(find "$plans_dir" -maxdepth 1 -name '*.md' -mmin -2 -printf '%T@ %p\n' 2>/dev/null \
  | sort -rn | head -1 | cut -d' ' -f2-)
[[ -n "$latest_plan" && -f "$latest_plan" ]] || exit 0

plan_content=$(cat "$latest_plan")
[[ -n "$plan_content" ]] || exit 0

# Archive: same structure as archive-plan
dest="$cwd/plans/$(date +%Y-%m-%d)"
mkdir -p "$dest"

# Slug from heading (same logic as archive-plan:64)
slug=$(head -1 "$latest_plan" | sed 's/^#\+ *//' \
  | sed -E 's/^(Plan|Add|Fix|Update|Implement|Create|Remove|Refactor)[: ] *//i' \
  | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' \
  | sed 's/^-//;s/-$//' | cut -c1-60)
[[ -n "$slug" ]] || slug="plan"

final="$dest/$slug.md"
if [[ -e "$final" ]]; then
  n=2; while [[ -e "$dest/$slug-$n.md" ]]; do ((n++)); done
  final="$dest/$slug-$n.md"
fi

echo "$plan_content" > "$final"
git -C "$cwd" add "$final" 2>/dev/null || true
exit 0
```

### settings.json configuration

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "ExitPlanMode",
      "hooks": [{
        "type": "command",
        "command": "~/.local/bin/archive-plan",
        "timeout": 20
      }]
    }],
    "SessionEnd": [{
      "hooks": [{
        "type": "command",
        "command": "~/.local/bin/archive-plan-on-clear",
        "timeout": 10
      }]
    }]
  }
}
```

---

## Regression testing

After implementing the solution, we ran 4 tests to verify all cases:

| # | Test | Expected | Result |
|---|------|----------|--------|
| 1 | Accept + reset context | Plan archived by `archive-plan-on-clear` | **PASS** — `context.md` created and staged |
| 2 | Accept sans reset | Plan archived by `archive-plan` | **PASS** — `regression-test-file-creation.md` created and staged |
| 3 | /clear simple | No plan archived | **PASS** — no new file |
| 4 | /exit simple | No plan archived | **PASS** — no new file |

Final state of the test repo:
```
plans/2026-03-11/
├── context.md                         ← archived by archive-plan-on-clear (accept+reset)
├── hello-world-file-plan.md           ← archived by archive-plan (same-session accept)
└── regression-test-file-creation.md   ← archived by archive-plan (regression test)
```

All 3 files staged in git, ready for commit.

---

## Reference: transcript JSONL structure

Each session has a `.jsonl` file at `~/.claude/projects/<encoded-project-path>/<session-uuid>.jsonl`. Each line is an independent JSON object. The project path is URL-encoded (e.g., `/home/user/projects/Foo` becomes `-home-user-projects-Foo`).

### Message types

| `type` | Description | Typical count |
|--------|-------------|---------------|
| `progress` | Hook execution events, tool progress callbacks | ~3-5 at session start (one per hook) |
| `user` | User messages and tool results | varies |
| `assistant` | Claude responses (text blocks and tool_use blocks) | varies |
| `system` | System events (bridge status, local command metadata) | ~1-2 |
| `file-history-snapshot` | File state tracking for undo/restore | ~1-3 |
| `last-prompt` | Marks end of a turn | 1 per turn |

### Common fields on all messages

```json
{
  "type": "user|assistant|progress|system|file-history-snapshot",
  "uuid": "unique-message-id",
  "timestamp": "2026-03-11T14:11:12.000Z",
  "sessionId": "session-uuid",
  "cwd": "/absolute/path/to/project",
  "gitBranch": "branch-name",
  "version": "2.1.72"
}
```

### Progress entries (hook outputs)

```json
{
  "type": "progress",
  "data": {
    "type": "hook_progress",
    "hookEvent": "SessionStart",
    "hookName": "SessionStart:clear",
    "command": "~/path/to/hook-script.sh"
  },
  "slug": "shimmying-foraging-donut"
}
```

The `hookName` field encodes both the event and the source/reason (e.g., `SessionStart:clear`, `SessionStart:startup`). The `slug` is a randomly generated session identifier.

### Plan injection format

When "Accept and reset context" injects a plan into the implementation session, it appears as a user message with a `planContent` field at root level:

```json
{
  "type": "user",
  "planContent": "# Plan: Full markdown plan content...",
  "message": {
    "role": "user",
    "content": "Implement the following plan:\n\n# Plan: ..."
  }
}
```

- `planContent` is at root level, NOT nested in `message.content`
- `message.content` is a string starting with `"Implement the following plan:\n\n"`
- This message only appears in the **implementation session** (session B), never in the planning session (session A)
- It is the 6th line of the transcript (after file-history-snapshot + 4 progress entries from hooks)

### Transcript timing relative to hooks

```
1. Claude Code allocates session ID and transcript_path
2. SessionStart hooks fire          ← transcript file does NOT exist yet
3. Progress entries written          ← transcript file created
4. First user message written        ← planContent appears here (if plan-injected)
```

This is why SessionStart hooks cannot read the transcript synchronously. By the time you get `transcript_path` on stdin, the file hasn't been created yet.

---

## Reference: hook stdin JSON payloads

All hooks receive JSON on stdin with these common fields:

```json
{
  "session_id": "uuid",
  "transcript_path": "/home/user/.claude/projects/.../uuid.jsonl",
  "cwd": "/working/directory",
  "hook_event_name": "SessionStart|SessionEnd|PostToolUse|..."
}
```

### SessionStart

```json
{
  "session_id": "eb85a389-...",
  "transcript_path": "/home/user/.claude/projects/.../eb85a389-....jsonl",
  "cwd": "/path/to/project",
  "hook_event_name": "SessionStart",
  "source": "startup",
  "model": "claude-opus-4-6"
}
```

| Field | Values | Notes |
|-------|--------|-------|
| `source` | `"startup"`, `"resume"`, `"clear"`, `"compact"` | `"clear"` = /clear or "Accept and reset context" |
| `model` | `"claude-opus-4-6"`, etc. | **Only present when `source: "startup"`** — missing on "clear", "resume", "compact" |

### SessionEnd

```json
{
  "session_id": "eb85a389-...",
  "transcript_path": "/home/user/.claude/projects/.../eb85a389-....jsonl",
  "cwd": "/path/to/project",
  "hook_event_name": "SessionEnd",
  "reason": "clear"
}
```

| Field | Values | Notes |
|-------|--------|-------|
| `reason` | `"clear"`, `"other"`, `"prompt_input_exit"`, `"logout"`, `"bypass_permissions_disabled"` | `"clear"` = /clear or "Accept and reset context" |

### PostToolUse (ExitPlanMode)

```json
{
  "session_id": "3807d9bd-...",
  "transcript_path": "/home/user/.claude/projects/.../3807d9bd-....jsonl",
  "cwd": "/path/to/project",
  "permission_mode": "acceptEdits",
  "hook_event_name": "PostToolUse",
  "tool_name": "ExitPlanMode",
  "tool_input": {},
  "tool_response": {
    "plan": "# Plan title\n\n## Context\n...",
    "isAgent": false,
    "filePath": "/home/user/.claude/plans/harmonic-painting-pretzel.md",
    "hasTaskTool": true
  },
  "tool_use_id": "toolu_01KaL6Ed..."
}
```

| Field | Notes |
|-------|-------|
| `tool_response.plan` | Full plan markdown content |
| `tool_response.filePath` | Path to the plan file in `~/.claude/plans/` |
| `tool_response.isAgent` | Whether the plan was created by a subagent |
| `tool_response.hasTaskTool` | Whether the TaskCreate tool was available |
| `permission_mode` | Switches to `"acceptEdits"` after plan acceptance |

### Environment variables available to hooks

| Variable | Available in | Description |
|----------|-------------|-------------|
| `CLAUDE_PROJECT_DIR` | All hooks | Absolute project root. More reliable than `cwd` from JSON (bug #22343: `cwd` can be `~`) |
| `CLAUDE_ENV_FILE` | SessionStart only | Path to a file where you can write `KEY=VALUE` lines to persist env vars for subsequent Bash tool commands |
| `CLAUDE_CODE_REMOTE` | All hooks | `"true"` if running in a web/remote environment |

---

## Reference: discrepancies with official documentation

| Topic | Official docs say | Observed behavior (March 2026) |
|-------|-------------------|-------------------------------|
| SessionEnd on /clear | GitHub issue #6428 says it doesn't fire | **Fires reliably** in all our tests |
| transcript_path at SessionEnd | GitHub issue #30217 says file may be deleted | **Exists and is readable** — the bug may be Conductor/multi-session specific |
| transcript_path at SessionStart | Not documented | **Does NOT exist** — file is created after hooks complete |
| "Accept and reset context" sequence | Not documented anywhere | SessionEnd(clear) → SessionStart(clear), ExitPlanMode rejected in transcript |
| SessionStart `model` field | Documented as always present | **Only present on `source: "startup"`**, missing on `source: "clear"` |
| Planning session end (same-session accept) | Not documented | **No SessionEnd fires** — the planning session transitions silently to a new session |
| ExitPlanMode on "Accept and reset" | Not documented | Claude calls ExitPlanMode but **the tool is rejected** (`"The user doesn't want to proceed"`) — PostToolUse never fires |
| SessionEnd matcher support | Reference doc (Jan 2026): "No" | The `reason` field exists and is populated with distinct values — matcher behavior needs formal verification |

### Key undocumented behaviors

1. **Plan acceptance always creates a new session** — even "accept in same session" creates a new session (different ID, new SessionStart). The difference is whether context carries over.

2. **"Accept and reset context" rejects ExitPlanMode** — this is the mechanism. Claude proposes ExitPlanMode as a tool_use, and the UI action rejects it before completion, then does a clear. This is visible in the transcript as a tool_result containing `"The user doesn't want to proceed with this tool use"`.

3. **SessionEnd is side-effects only** — no `systemMessage` or `additionalContext` output is possible. The session is terminating; there's no conversation to inject context into.

4. **Hook output format**: SessionEnd hooks can write to stdout/stderr but it has no effect on the conversation. Only SessionStart, UserPromptSubmit, and PreToolUse/PostToolUse hooks can inject context.
