# Claude Meta-Tools Plugin

v5.0.0

Prompt tooling for Claude Code: write and audit prompts, and introspect how the harness executes them.

Since 5.0.0 this plugin is prompt-focused. Instruction-file maintenance moved to
[context-management](../context-management/), research and fact-checking to
[research-tools](../research-tools/), `/explain` and `/troubleshoot` to
[understanding](../understanding/).

## Commands

### `/meta-prompt`

Turn a rough request — or the preceding conversation — into a grounded, ready-to-run prompt
for another agent. Verifies every path and symbol it cites against the repo, retargets when
grounding contradicts the request, mines conversation decisions when invoked as a handoff,
and tailors verification scaffolding to the executor model.

```bash
/meta-prompt add rate limiting to the API gateway
/meta-prompt            # no arguments: hand off the task discussed in this session
```

### `/prompt-coach`

Rephrase rough ideas into clear, professional language — and name the weak patterns so you
learn from them.

### `/prompt-health`

Health check for a prompt, command, skill, or agent doc. Two layers, no scores:

- **Harness staleness (deterministic)**: checks the artifact against Claude Code facts that
  changed — `ultrathink` as a budget dial, the spawn tool named `Task` rather than `Agent`,
  `budget_tokens`, assistant prefill, pinned prior-generation model IDs.
- **Dated patterns (delegated)**: hands off to the vendored prompt-audit methodology for
  pressure language, replaced scaffolds, over-specification, and the proposed diff.

```bash
/prompt-health path/to/SKILL.md
/prompt-health "inline prompt text" --model opus-5
```

### `/dump-system-prompt`

Extract Claude Code system prompts from `cli.js` using AST analysis. Backed by
`scripts/extract-system-prompts.sh` and `scripts/track-prompt-versions.sh`.

### `/explain-workflow`

Trace and visualize the execution flow of a Claude Code command, skill, or agent workflow.

## License

Apache-2.0

## Author

Augustin BENGOLEA <bengous@protonmail.com>
