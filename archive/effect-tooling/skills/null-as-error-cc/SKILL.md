---
name: null-as-error-cc
description: >
  Audit an Effect codebase for silent error swallowing -- catchAll patterns that collapse
  errors into sentinel values (null, [], false, void) in the success channel. Runs a
  scanner script, spawns a read-only auditor, and produces a classified report.
  NOT for: non-Effect projects, React/frontend code, plain TypeScript without Effect.
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Agent
---

# null-as-error

Detect silent error swallowing in Effect codebases. The antipattern:
`catchAll(() => Effect.succeed(null))` collapses real errors (disk full, permissions)
into sentinel values (`null`, `[]`, `false`) that callers cannot distinguish from
normal absence.

## Project context

- effect_posture: !`~/.claude/skills/null-as-error-cc/scripts/probe-effect.sh`

## Workflow

### Phase 1 -- Gate on Effect

If the probe above shows `effect="false"`, stop immediately:

> This project does not use Effect. The null-as-error scanner targets Effect-specific
> patterns (catchAll, Effect.succeed, Effect.ignore). Nothing to scan.

### Phase 2 -- Run scanner

Execute the scanner script. The user may provide a scope (directory path) as an argument;
default to `src/`.

```bash
bun ~/.claude/skills/null-as-error-cc/scripts/scan.ts [scope] --json
```

Capture the JSON output. If `meta.hitsFound` is 0:

> No silent error swallowing patterns found in [scope]. Clean.

Stop here.

### Phase 3 -- Semantic analysis

The scanner found hits. Spawn the auditor subagent to classify each one:

```
Agent({
  subagent_type: "null-as-error-auditor",
  prompt: <see below>
})
```

The auditor task prompt must include:
- The full scanner JSON output
- Reference file paths for the auditor to read:
  - `~/.claude/skills/null-as-error-cc/references/patterns.md`
  - `~/.claude/skills/null-as-error-cc/references/fixes.md`
  - `~/.claude/skills/null-as-error-cc/references/guardrails.md`

### Phase 4 -- Report

Synthesize the auditor's findings into a final report:

```markdown
## Silent Error Swallowing Audit

### Summary
- Scanned: N files in [scope]
- Found: N occurrences
- Breakdown: X errors, Y warnings, Z info, W suppressed

### Findings

#### [ERROR] ...
#### [WARNING] ...
#### [INFO] ...
#### [SUPPRESSED] ...

### Summary Table
| Function | File | Severity | Sentinel | Fix | Blast Radius |
|----------|------|----------|----------|-----|--------------|
```

## Reference navigation

| Question | Load |
|---|---|
| Detection patterns and severity rules | `references/patterns.md` |
| Fix strategies and decision tree | `references/fixes.md` |
| False-positive prevention | `references/guardrails.md` |
| Auditor agent definition | `~/.claude/agents/null-as-error-auditor.md` |
