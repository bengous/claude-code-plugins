# goalify: Codex → Claude Code port notes

This skill is a port of the Codex CLI `goalify` skill (`agents-skills/goalify`).
The core behavior is unchanged: turn rough intent into the smallest useful goal
payload. The harness-specific apparatus was adapted or dropped.

## What changed

### Consumer: `/goal` → fresh Claude Code agent

The Codex original produced text to paste after Codex/Pi's built-in `/goal`
(the RALF persistent-goal loop), and avoided prefixing output with `/goal`
because those harnesses wrap it with their own objective label.

Claude Code has no `/goal` primitive. The payload now targets a generic
consumer: a new session, a subagent (Agent tool), or `/loop`. The objective is
still the first line, now because the consuming agent reads the first line as
the task statement (not to dodge a wrapper label). The "do not prefix with
`/goal`" rule is gone; the "do not start with `Objective:`" rule is kept.

### Long goals: `codex-goal` helper → plain `Write`

The Codex original required `codex-goal`, a Linux helper that wrote long goals to
`.agents/goals/*.md` and set the inode immutable flag (via a root-owned wrapper +
`/etc/sudoers.d` rule). Its purpose was to protect the goal file from the
executing agent under Codex `danger-full-access`.

That apparatus is intentionally **not** ported:

- It installs a sudoers rule and a privileged binary, which is inappropriate to
  ship in a Claude Code plugin.
- Claude Code mediates writes through permission modes rather than running a
  single unconstrained shell, so the "agent silently rewrites its own goal"
  threat is much weaker.

Long goals are now written with the ordinary `Write` tool to
`.agents/goals/<slug>.md` (no immutability). The `.agents/goals/` location is
kept so the artifact stays harness-neutral, matching the original intent. The
Entry Gate and Helper Contract sections were removed.

### Invocation control: `allow_implicit_invocation: false` → `disable-model-invocation: true`

The Codex `agents/openai.yaml` disabled implicit invocation so the skill would
not hijack normal implementation/review/planning prompts. The Claude Code
equivalent is `disable-model-invocation: true` in the SKILL.md frontmatter: only
the user invokes it (via `/goalify`); Claude will not auto-load it.

### Interactive mode → AskUserQuestion

Question-first mode now uses the AskUserQuestion tool (one decision at a time,
recommended option first) instead of free-form one-question-at-a-time prose.

## Unchanged

Core principle, prompt shape, slug rules, clarification rules, and the quality
check are carried over with only the helper/`/goal` references removed.
