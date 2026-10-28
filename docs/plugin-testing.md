# Plugin testing

Choose the page for the task. Read its linked references only when the procedure
needs them. Code paths in these pages are relative to the repository root.

| Task | Read |
|---|---|
| Field-test a behaviour change in a live session an agent drives, base against change | [`field-test` skill](../.claude/skills/field-test/SKILL.md) |
| Launch from source, isolate permissions, inspect transcripts | [Test sessions](plugin-testing/sessions.md) |
| Diagnose skill interpolation, permission rules or prompt text | [Skill permissions and prompts](plugin-testing/skills.md) |
| Test a command hook or function-hooks module | [Hook tests](plugin-testing/hooks.md) |
| Activate, inspect, repair or undo the dev catalog | [Managed catalog](plugin-testing/catalog.md) |
| Check installed copies and validate a release through the marketplace | [Installed plugins and release checks](plugin-testing/release.md) |

Use `command claude` in permission tests: the owner's `claude` shell function
injects bypass permissions. Only `default` mode exposes missing grants.

Record engine observations in the relevant page, with their source and any
unmeasured limits. Hook runtime details belong in the reference linked from
[hook tests](plugin-testing/hooks.md), not in this index.
