# SubagentStop

> Fires right before a subagent concludes its response — can block to request corrections.

## Basics

- **Fires when:** A subagent (Agent tool call) is about to return its final response
- **Can block:** Yes
- **Matcher:** Agent type

### Minimal example

```jsonc
{
  "hooks": {
    "SubagentStop": [
      {
        "hooks": [{
          "type": "command",
          "command": "~/.local/bin/etch-subagent-stop",
          "timeout": 30
        }]
      }
    ]
  }
}
```

## Input / Output

### Stdin (JSON)

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | `string` | Parent session identifier |
| `cwd` | `string` | Working directory |
| `agent_id` | `string` | Unique identifier for this subagent |
| `agent_type` | `string` | Type of subagent |
| `last_assistant_message` | `string` | The subagent's final response text (may be available) |

### Stdout (JSON)

```jsonc
{
  "decision": "block",
  "reason": "Subagent did not run tests before completing"
}
```

Or inject context without blocking:

```jsonc
{
  "hookSpecificOutput": {
    "hookEventName": "SubagentStop",
    "additionalContext": "Score: 7.2 — above threshold, evaluation forked"
  }
}
```

### Exit codes

| Exit code | Behavior |
|-----------|----------|
| `0` | Decision is read from stdout JSON |
| `0` (no stdout) | Subagent concludes normally |
| `2` | Subagent response is blocked |
| Other | Hook error — logged, subagent concludes normally |

## Patterns

### Score and evaluate subagent work

Run the same scoring pipeline used for main sessions, but scoped to subagent output. If the score exceeds a threshold, spawn a fire-and-forget evaluation fork to assess quality in detail.

```jsonc
{
  "hooks": [{
    "type": "command",
    "command": "/home/user/.local/bin/etch-subagent-stop",
    "timeout": 30
  }]
}
```

The script:

1. Reads `session_id`, `agent_id`, and `last_assistant_message` from stdin
2. Computes a session score based on signals: message length, edit-to-read ratio, git commits made, tool failure count
3. If the score exceeds the evaluation threshold, spawns a detached Claude subprocess that writes a structured evaluation event to SQLite
4. Outputs the score as `additionalContext` so it appears in the parent session's context

```typescript
// Simplified scoring logic
const input = await Bun.stdin.json();
const score = computeSessionScore({
  messageLength: input.last_assistant_message?.length ?? 0,
  // ... other signals from session state
});

if (score >= EVAL_THRESHOLD) {
  // Fire-and-forget: spawn evaluation subprocess
  spawnEvalFork(input.session_id, input.agent_id, score);
}

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SubagentStop",
    additionalContext: `Session score: ${score.toFixed(1)}${score >= EVAL_THRESHOLD ? " — evaluation forked" : ""}`,
  },
}));
```

### Log subagent completion

```bash
#!/usr/bin/env bash
INPUT=$(cat /dev/stdin)
echo "$INPUT" | jq -c '{ts: now | todate, event: "stop", agent_id, agent_type, session_id}' \
  >> /tmp/claude-subagents.jsonl
```

### Validate subagent output

Block if the subagent's response is suspiciously short or missing expected content:

```bash
#!/usr/bin/env bash
INPUT=$(cat /dev/stdin)
MSG_LEN=$(echo "$INPUT" | jq -r '.last_assistant_message // "" | length')

if [ "$MSG_LEN" -lt 50 ]; then
  cat <<EOF
{
  "decision": "block",
  "reason": "Subagent response too short ($MSG_LEN chars). Elaborate on findings before concluding."
}
EOF
fi
```

## Edge Cases

- `last_assistant_message` may not always be populated — check before relying on it.
- Blocking a SubagentStop tells the subagent its response is insufficient and it should continue working. The block reason is injected as context.
- The subagent shares the parent's `session_id` but has its own `agent_id`.
- Evaluation forks spawned from this hook should be fire-and-forget (detached process) to avoid blocking the subagent's return.

## Resources

- [Hooks Reference](https://code.claude.com/docs/en/hooks) — official documentation
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/)

## See Also

- [SubagentStart](subagent-start.md) — fires when the subagent is spawned
- [Stop](../completion/stop.md) — the equivalent hook for main session completion
