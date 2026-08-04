# Understanding Plugin

v1.0.0

Understand a topic or a bug: minimal explanations and root-cause diagnosis.

Moved from software-craft 1.1.0 (originally claude-meta-tools).

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

## License

MIT

## Author

Augustin BENGOLEA <bengous@protonmail.com>
