---
paths:
  - "*/skills/**/SKILL.md"
---

# Commands a skill tells the model to run

The model copies a skill's example commands verbatim, so each example must
pass the permission check as written. Measured cases, details and repro
recipes in `docs/plugin-testing.md` → Skill mechanics worth knowing.

- No environment assignment in front of the executable: an `allow` rule
  stops at `VAR=x cmd` unless `VAR` is on Claude Code's short known-safe
  list. Pass config through the command instead (`git -c key=value ...`).
- No `$(...)` or backtick substitution: it prompts in `default` mode
  whatever the rule says. Write a literal or a placeholder the model fills.
- No editor: the session exports `GIT_EDITOR=true`, which beats
  `-c core.editor` and `EDITOR`. Feed text through a file (`-F`, `--body-file`)
  or an `exec` line.
- `description` ends with a "Use when ..." clause naming the user intents;
  a bare capability summary under-triggers.
