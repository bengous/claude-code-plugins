---
description: Health check for a prompt, command, skill, or agent doc — deterministic Claude Code harness staleness checks, then the native /claude-api prompt-audit for dated patterns
argument-hint: "<file-path, glob, or inline prompt> [--model <target-model>]"
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash(rg:*, grep:*, git:*, ls:*, wc:*, head:*)
  - Skill
disallowed-tools:
  - Write
  - Edit
---

# Prompt Health

Two-layer health check of a prompt artifact: a deterministic harness-staleness pass
(reproducible run to run), then the native `/claude-api prompt-audit` for dated prompting
patterns. This command never edits files — findings and the proposed diff are for the caller
to apply. It is also non-interactive: state assumptions in the report; never stop to ask.

## Step 1: Load the artifact

Treat the input as a file reference only when it starts with `/`, `./`, or `~`, contains a
glob metacharacter (`*`, `?`, `[`), or ends in `.md` — resolve it with Glob and Read every
match. Otherwise treat it as inline prompt text; prose containing slashes is still prose.

## Step 2: Harness staleness pass (deterministic)

<!-- Dead-mechanisms provenance:
     sources: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices.md
              + https://code.claude.com/docs/en/{skills,slash-commands,model-config}.md
              + https://platform.claude.com/docs/en/build-with-claude/effort.md
     fetched: 2026-07-26
     refresh: re-verify each row against current docs — resolve current slugs via
              https://platform.claude.com/llms.txt (page names have been renamed before;
              do not hardcode a versioned slug) — then update the fetched date. -->

Check the artifact against each row. These are Claude Code harness facts the native audit does
not cover (it audits the API surface, not the harness). An artifact asserting any of these is
factually wrong, not merely dated.

| Assertion in the artifact | Reality |
|---|---|
| `think` / `think hard` / `think harder` / `think more` allocate thinking budget | Not keywords. Passed through as ordinary prompt text. |
| `ultrathink` sets maximum thinking budget | Recognized, but it adds an in-context instruction and the effort level sent to the API is unchanged. Not a budget dial. |
| `budget_tokens` caps thinking | Returns **400** on Claude 4.7+. Deprecated on 4.6. Use adaptive thinking plus `effort`. |
| Prefill the assistant turn to steer format | Returns **400** on Claude 4.6+. Use structured outputs. |
| Workarounds that avoid or replace the word "think" | Premised on thinking being disabled. Fable 5 and Mythos 5 are thinking-always-on. |
| The subagent-spawning tool is named `Task` | It is `Agent`. Note that `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` are real and unrelated — do not match a bare "Task". |
| Pinned prior-generation model IDs in self-knowledge boilerplate | Current IDs: `claude-fable-5`, `claude-mythos-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`. Prefer abstract aliases in frontmatter. |

Report every match as `file:line`, the quoted assertion, and what is true instead. A clean
result is reported as `none` plus what was checked — do not compensate with a verdict or
score.

## Step 3: Dated-pattern audit (delegated)

Invoke the native audit with the Skill tool: skill `claude-api`, args
`prompt-audit <scope>` — append the target model when the user passed `--model`. The skill
executes inline in this context: for a file scope pass the path(s); for inline prompt text,
state in the args that the scope is the inline text already provided in the conversation. The
audit is non-interactive: it states its assumptions, scans for dated prompting patterns, and
produces an audit report plus a proposed diff without applying anything.

## Step 4: Report

Two sections, in order:

1. `## Harness staleness` — the Step 2 findings, or `none`.
2. The native audit's report and proposed diff, in full — do not summarize, re-rank, or drop
   findings.

No scores, no grades, no interactive questions. The native audit's per-finding confidence
levels (High/Medium/Low) are part of its report, not a grade — keep them. The caller applies
hunks on their own schedule.
