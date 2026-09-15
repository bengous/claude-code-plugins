# Vellum

A Claude Code plugin: the `/vellum:plan` skill writes a plan; at `ExitPlanMode` a hooks
module opens the plan and its artifacts in the browser, and the reviewer's answer reaches
Claude as a prompt. Function hooks, early access: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.

Layers, dependency direction and the rules of the code: `.claude/rules/architecture.md`,
loaded with this file. The drawings, the assessment and the proposed shape for the next
phases, for the people who change the tree: `docs/architecture.md`.

## Commands

```bash
bun install --cwd vellum                                            # once; Claude Code does it at the plugin's cache
bun test vellum                                                     # every suite of the plugin
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate vellum   # what the hooks module hooks and calls
claude -p --setting-sources project "/plugin-types vellum/types"    # regenerate types/claude-code.d.ts after a Claude Code update; keep claude-code.d.ts only
```

A live session, the browser, and the facts measured on Claude Code: `docs/plugin-testing.md`
at the repository root, § Testing a hooks module, and `plans/2026-09-15/plan-review-rewrite/`.

## Boundaries

- `hooks/register.ts` is self-contained: types from `claude-code`, nothing from `src/`.
- `types/claude-code.d.ts` is generated, never edited; `vellum/types/**` is ignored by the linters.
- `package.json` + `bun.lock` carry every runtime dependency; a new one goes through the ladder in the repository's `AGENTS.md` first.
- Every value crossing HTTP or a plugin boundary is JSON: `src/protocol.ts` is the one place it is typed.
- The page is bundled at run time by `Bun.serve` from `ui/index.html`; no build step, sources shipped.
