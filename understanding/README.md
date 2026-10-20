# Understanding Plugin

v1.1.0

Understand a topic, a bug, a Claude Code workflow, or the last reply: minimal explanations,
root-cause diagnosis, execution traces, layered recaps.

`/explain` and `/troubleshoot` moved from software-craft 1.1.0 (originally claude-meta-tools).
`/explain-workflow` moved from claude-meta-tools 6.0.0.

## Commands

### `/explain`

Explain a concept, code pattern, or topic — the minimum that makes it understood.
Grounds in the codebase with `file:line` when relevant, verifies contested or precise
claims with the research tools, and draws at most one diagram, only when it shows a
mechanism prose can't hold.

```bash
/explain event loop starvation in Node
```

### `/troubleshoot`

Diagnose the root cause of a bug or issue — investigation only, no code changes.
Reads code and git history, traces data flow, optionally adds labeled debug
statements, then reports Root Cause / Evidence / Context / Next Steps.

```bash
/troubleshoot login form silently drops the session cookie
```

### `/explain-workflow`

Trace the execution flow of a Claude Code command, skill, or agent: every tool call,
branch, delegation, and script, followed into its source file, rendered as an ASCII flow
diagram with `file:line` references. Not a concept explanation; use `/explain` for that.

```bash
/explain-workflow git:commit
/explain-workflow plans/release-pipeline.md
```

### `/recap`

Re-explain the last reply from zero, for a user who did not read it, in three layers that
each stand alone: the decision waiting for the user and what changed in the world; the shape
of what happened, as one pseudocode, call tree, Mermaid diagram, table or short argument;
the numbered steps, each with what checked it. Read-only and user-invoked only.

```bash
/recap
/recap decisions        # layer 1 only; also: steps, diagram
/recap why did the push fail?
```

Known gaps: the model sometimes shortens a quoted command or inlines a constant in the diagram.
Not worth a rule unless it misleads a decision.

### `/didnt-read`

Alias of `/recap steps`: layers 1 and 3. Both commands inject `shared/recap-body.md` with
`` !`cat` ``, so they never drift apart; the body sits outside `commands/`, where every file
becomes a command. `cat`, not `sed`: the permission check reads `sed` as an edit and refuses
it. The `Read(//**/understanding/shared/recap-body.md)` rule lets `cat` reach the plugin
folder, which lies outside the session's working directory.

```bash
/didnt-read
```

## License

MIT

## Author

Augustin BENGOLEA <bengous@protonmail.com>
