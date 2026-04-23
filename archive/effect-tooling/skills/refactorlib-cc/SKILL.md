---
name: refactorlib-cc
description: >
  Audit a codebase for handcrafted code that duplicates functionality already available in the
  project's dependencies. Reads package.json, launches parallel exploration agents, verifies
  replacement feasibility, and produces a structured refactor plan. Audit only -- does not
  execute changes.
disable-model-invocation: true
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Agent
  - WebFetch
  - WebSearch
  - mcp__Context7__resolve-library-id
  - mcp__Context7__query-docs
  - mcp__exa__web_search_exa
  - mcp__exa__get_code_context_exa
  - mcp__exa__crawling_exa
  - mcp__bun__run-bun-eval
  - mcp__bun__get-bun-version
  - mcp__bun__analyze-bun-performance
---

# refactorlib

Audit a codebase for handcrafted code that could be replaced by existing dependencies.

Projects accumulate utility code over time. Some predates a dependency that now covers the same
ground; some was written before the team discovered a library API. Removing these duplications
shrinks maintenance surface and leverages battle-tested implementations with better edge-case
handling and security patches.

## Project context

- deps: !`bun -e "const p=JSON.parse(await Bun.file('package.json').text()); console.log(JSON.stringify({...p.dependencies,...p.devDependencies}))" 2>/dev/null`
- runtime: !`bun --version 2>/dev/null || node --version 2>/dev/null`
- has_effect: !`bun -e "const p=JSON.parse(await Bun.file('package.json').text()); console.log(p.dependencies?.effect || p.devDependencies?.effect ? 'yes' : 'no')" 2>/dev/null`
- has_bun: !`bun -e "const p=JSON.parse(await Bun.file('package.json').text()); console.log(p.devDependencies?.['@types/bun'] ? 'yes' : 'no')" 2>/dev/null`
- src_dirs: !`ls src/ 2>/dev/null | head -20`

## Workflow

### Phase 1 -- Route on context

The project context above was resolved at skill load time. Use it to decide which pattern
catalogs each agent should read:

- **If has_effect == "yes"**: include `references/patterns/effect-infra.md` in the infra
  agent's pattern list
- **Always**: include `references/patterns/runtime-infra.md` for infra agent,
  `references/patterns/general-utility.md` and `references/patterns/runtime-utility.md`
  for utility agent

The subagents have `effect-usage` and `bun` skills preloaded — no need to load companion
skills in the orchestrator.

### Phase 2 -- Parallel exploration

Spawn two custom subagents in parallel. Each receives a short task prompt with:
- Project dependencies (from `deps` above)
- Source directories (from `src_dirs` above)
- Pattern catalog file paths to read (from Phase 1 routing)
- Guardrails: `~/.claude/skills/refactorlib-cc/references/guardrails.md`
- Report format: `~/.claude/skills/refactorlib-cc/references/report-format.md`
- The user's request (or "Full audit -- no scope restriction")

```
Agent({ subagent_type: "refactorlib-infra", prompt: <task prompt> })
Agent({ subagent_type: "refactorlib-utility", prompt: <task prompt> })
```

The agents' system prompts (from their markdown definitions) provide the methodology.
Their preloaded skills (effect-usage, bun) provide deep API knowledge with progressive
disclosure.

### Phase 3 -- Triage and deep-dive

Synthesize agent findings. For each candidate, classify:

| Verdict | Meaning |
|---------|---------|
| **REPLACE** | Clear duplication. Library equivalent exists, is proven compatible, and is installed. |
| **INVESTIGATE** | Likely replaceable but needs API verification or output comparison. |
| **KEEP** | Intentionally custom. See `references/guardrails.md`. |

For REPLACE and INVESTIGATE candidates, perform these verification steps:

1. **Read the source** -- understand the full implementation, not just the grep match
2. **Count callers** -- `grep -r` for imports to gauge blast radius
3. **Verify the API exists** -- grep type declarations in `node_modules/*/dist/dts/` for the
   replacement API. An API that looks right in docs might not exist in the installed version.
4. **Test output compatibility** (for INVESTIGATE) -- run both implementations with identical
   input via `bun -e` and compare output. This catches subtle differences in encoding,
   formatting, or edge-case behavior.

Only promote INVESTIGATE to REPLACE after step 4 confirms identical behavior.

### Phase 4 -- Structured output

Produce the final report using this template:

```
## Library Replacement Audit

### Dependencies scanned
- <dep>: <what it provides>

### Candidates

#### [REPLACE] <title>
- files: <paths with line ranges>
- callers: <N files import this>
- current: <what the code does, 1 line>
- replacement: <library API, 1 line>
- effort: low | medium | high
- gain: <lines removed, better edge-case handling, etc.>
- verified: yes | no
- code_before: |
    <snippet>
- code_after: |
    <snippet>

#### [INVESTIGATE] <title>
- files: <paths>
- current: <what the code does>
- candidate: <library API>
- blocker: <what needs verification>

#### [KEEP] <title>
- files: <paths>
- reason: <why this is intentionally custom>

### Summary
| Candidate | Verdict | Effort | Gain | Verified |
|-----------|---------|--------|------|----------|
```

## False-positive guardrails

See `references/guardrails.md`. Agents are directed to read this file during exploration.

## Reference navigation

| Question | Load |
|---|---|
| Effect infrastructure patterns? | `references/patterns/effect-infra.md` |
| Bun/Node infrastructure APIs? | `references/patterns/runtime-infra.md` |
| Bun/Node utility APIs? | `references/patterns/runtime-utility.md` |
| General utility patterns? | `references/patterns/general-utility.md` |
| False-positive guardrails? | `references/guardrails.md` |
| Infra subagent? | `dot_claude/agents/refactorlib-infra.md` |
| Utility subagent? | `dot_claude/agents/refactorlib-utility.md` |
| Agent report format? | `references/report-format.md` |
