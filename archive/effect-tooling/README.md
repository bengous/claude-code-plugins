# effect-tooling (archived)

Bundle of Claude Code agents, skills, and a slash command for auditing Effect (effect-ts) codebases. Archived because the current projects under active work do not use Effect, so the tooling was permanently installed but unused.

## Contents

```
agents/
  effect-architecture-reviewer.md   # reviews whether Effect should be adopted / where
  null-as-error-auditor.md          # read-only auditor spawned by the null-as-error skill
  refactorlib-infra.md              # read-only infra code auditor spawned by refactorlib
  refactorlib-utility.md            # read-only utility code auditor spawned by refactorlib
commands/
  null-as-error.md                  # /null-as-error slash command wrapper
skills/
  null-as-error-cc/                 # audit Effect codebases for silent error swallowing
  refactorlib-cc/                   # find handcrafted code replaceable by installed libraries
```

`null-as-error-cc` and `refactorlib-cc` still live upstream in `b3ngous/agents-skills`; the snapshots here are copies taken at archival time.

## Why coupled

The agents are spawned by the skills and cannot work standalone:

- `null-as-error` (command) -> `null-as-error-cc` (skill) -> `null-as-error-auditor` (agent)
- `refactorlib-cc` (skill) -> `refactorlib-infra` + `refactorlib-utility` (agents)
- `effect-architecture-reviewer` is used ad-hoc when reviewing Effect architecture proposals.

Archiving them together prevents leaving dangling agent references when the skill is removed.

## Restore

1. Copy agents back: `cp agents/*.md ~/.claude/agents/`
2. Copy command back: `cp commands/null-as-error.md ~/.claude/commands/`
3. Re-install skills via `b3ngous/agents-skills` (upstream) or copy locally:
   ```bash
   cp -R skills/null-as-error-cc ~/.agents/skills/
   cp -R skills/refactorlib-cc   ~/.agents/skills/
   ln -s ../../.agents/skills/null-as-error-cc ~/.claude/skills/null-as-error-cc
   ln -s ../../.agents/skills/refactorlib-cc   ~/.claude/skills/refactorlib-cc
   ```
4. Remove both names from the `archived_skills` array in `~/dotfiles/.chezmoiscripts/run_after_install-global-skills.sh` so `chezmoi apply` stops pruning them.
