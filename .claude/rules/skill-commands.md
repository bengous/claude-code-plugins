---
paths:
  - "*/skills/**/SKILL.md"
---

# Commands a skill tells the model to run

The model copies a skill's example commands verbatim, so each example must
pass the permission check as written. Measured cases, details and repro
recipes in [Skill permissions and prompts](../../docs/plugin-testing/skills.md).

- No environment assignment in front of the executable: an `allow` rule
  stops at `VAR=x cmd` unless `VAR` is on Claude Code's short known-safe
  list. Pass config through the command instead (`git -c key=value ...`).
- No `$(...)` or backtick substitution: it prompts in `default` mode
  whatever the rule says. Write a literal or a placeholder the model fills.
- No editor: the session exports `GIT_EDITOR=true`, which beats
  `-c core.editor` and `EDITOR`. Feed text through a file (`-F`, `--body-file`)
  or an `exec` line.
- `allowed-tools` file rules are `Read(path)` and `Edit(path)` only, in
  gitignore syntax; `Edit` covers `Write`. `Write(*:*)` and `Read(*:*)`
  grant nothing, and neither does a rule on a tool that needs no approval
  (`Grep`, `Glob`, `Agent`, `AskUserQuestion`). An absolute path starts with
  `//`, a home path with `~/`; `${CLAUDE_PLUGIN_ROOT}` expands in `Bash` rules
  only. `Bash(*:*)` does not cover a bundled script: name it, unquoted,
  `Bash(${CLAUDE_PLUGIN_ROOT}/scripts/x *)`.
- A `Bash` rule does not cover a path argument outside the working
  directory: `ls`, `cat` or `cmp` there needs a `Read(path)` rule, `cp` both
  `Read(path)` and `Edit(path)` on its source. Past the executable, quote a path in the
  rule exactly as the command does.
- A skill that writes scratch files gives each run its own directory
  (`mktemp -d`, the model copies the printed path) so concurrent sessions
  never share a file; `/tmp` is world-readable and a symlink on macOS.
- `description` ends with a "Use when ..." clause naming the user intents;
  a bare capability summary under-triggers. A skill with
  `disable-model-invocation: true` needs none: its description never reaches
  the model.
- A skill whose effect leaves the machine or rewrites history without an
  undo (close, merge, push to a shared branch) carries
  `disable-model-invocation: true`: a natural-language request must not
  trigger it by accident. `github-flow`'s `dispatch` and `shift` are the
  exception, since a scheduled fire invokes only a model-invocable skill:
  their only push to a shared branch goes through the repository's landing
  command, which a code gate holds to the change's tier, green CI and, for a
  `tier:human` change, the `land-ok` the human's own words allow.
