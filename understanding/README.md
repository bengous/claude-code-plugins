# Understanding Plugin

v1.1.0

Understand a topic, a bug, or a Claude Code workflow: minimal explanations, root-cause
diagnosis, execution traces.

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

## License

MIT

## Author

Augustin BENGOLEA <bengous@protonmail.com>
