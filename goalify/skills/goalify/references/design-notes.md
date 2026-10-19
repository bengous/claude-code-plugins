# goalify: design notes

goalify writes the condition the user pastes after `/goal`. It descends from the
Codex CLI `goalify` skill (`agents-skills/goalify`), whose output fed Codex's
own persistent-goal loop. Claude Code's `/goal` is the same kind of consumer,
and the skill is shaped by how that consumer reads its input.

## The reader is the evaluator

`/goal` wraps a session-scoped prompt-based Stop hook: after each turn a small
fast model receives the condition and the conversation and returns met, not
met, or impossible, with a reason (Claude Code docs, "Keep Claude working
toward a goal", section "How evaluation works"). It runs no command and opens
no file. Every rule in `SKILL.md` follows from that:

- The end state is a fact a transcript can show, not an activity.
- The proof names the command and the output line, because the evaluator only
  sees what Claude prints.
- A blocker is written as an end state of its own, because a stuck run has no
  verdict of its own and reads as "not met" until the cap.
- The condition carries a turn cap, the only bound the docs offer short of
  `/goal clear`.
- Context the worker needs goes in a message sent before `/goal`, so the
  evaluator weighs only the condition.
- The whole text stays under 4000 characters, the harness limit on a condition.

## What goalify is not

`/meta-prompt` (claude-meta-tools) writes the brief a fresh agent acts on: the
user's intent, their decisions with the reasons they gave, the questions they
left open. A `/goal` condition has no room for an open question, since a clause
the evaluator cannot settle never resolves. The two compose: the message before
`/goal` is meta-prompt's; the `/goal` line is goalify's.

## Dropped from the Codex original

The `codex-goal` helper wrote long goals to `.agents/goals/*.md` under an
immutable inode, set through a sudoers rule, so the executing agent could not
rewrite its own goal under `danger-full-access`. Claude Code mediates writes
through permission modes, and a condition in a file is invisible to the
evaluator anyway, so the helper, the file output and the `Write` tool are gone.

`allow_implicit_invocation: false` became `disable-model-invocation: true`:
only the user starts goalify.
