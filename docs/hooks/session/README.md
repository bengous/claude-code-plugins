# Session Hooks

Session hooks fire during the lifecycle of a Claude Code session -- from initialization through teardown. Use them to set up state, inject context, and clean up resources. They are all **non-blocking**: a failing hook logs an error but never prevents the session from proceeding.

## Lifecycle Sequence

```
SessionStart
    |
    v
InstructionsLoaded   (once per CLAUDE.md / rules file)
    |
    v
  Setup              (repo initialization)
    |
    v
  ... interactive session ...
    |
    v
SessionEnd
```

## Event Summary

| Event | Can Block? | TL;DR |
|-------|-----------|-------|
| [SessionStart](session-start.md) | No | New session begins, resumes, or restarts after /clear or /compact |
| [InstructionsLoaded](instructions-loaded.md) | No | A CLAUDE.md or rules file is loaded into context |
| [Setup](setup.md) | No | Repo setup for initialization and maintenance tasks |
| [SessionEnd](session-end.md) | No | Session is terminating |

**Official docs:** [Hooks Reference](https://code.claude.com/docs/en/hooks) · [Hooks Guide](https://code.claude.com/docs/en/hooks-guide)
