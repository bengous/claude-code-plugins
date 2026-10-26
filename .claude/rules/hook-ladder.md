---
paths:
  - ".claude/hooks/**"
  - ".claude/__settings.jsonc"
  - ".claude/agent-hooks.jsonc"
  - "lefthook.yml"
  - ".lefthook/**"
  - "scripts/run-gates.ts"
  - "scripts/check-lint-config.ts"
  - "scripts/check-plugin-bumps.ts"
  - "scripts/check-e2e-green.ts"
---

# Hook ladder

The rungs run from each edit to CI: post-edit, Stop, pre-commit, pre-push,
CI. The post-edit hook applies the safe lint fixes of the edited file; the
agent meets any finding left once, at the end of its turn, not on each edit.

- The post-edit hook (`format-on-edit.ts`) fixes, formats and never blocks.
  A `.ts`, `.js`, `.mjs` or `.cjs` file goes through oxfmt, `oxlint --fix`,
  then oxfmt again: a line oxfmt wraps can need a blank line, and a fix can
  need formatting. A `.sh` file goes through shfmt. A tool failure stops
  the chain. The hook hands the failure, then the diff of the passes that
  ran, back as PostToolUse `additionalContext`, and nothing about the
  findings left. Claude Code renders a Write or Edit result from the file
  path alone, so `updatedToolOutput` cannot carry code there.
- `--fix` applies the fixes oxlint rates safe, never suggestions or dangerous
  fixes. `bun x oxlint --rules -f json` gives the fix kind of each built-in
  rule and omits JS plugin rules; among the `anti-slop` rules, only
  `require-readable-spacing` has a fixer (`fixable: 'whitespace'` in its
  vendored padding rule). Enabling a rule with a safe fixer changes what
  every edit rewrites.
- The tools run from the checkout of the project's repository that holds the
  edited file: the project or one of its worktrees, told apart from another
  repository by their shared git common dir (`placeOf` in `checkout.ts`).
  Run from the project on a file under `.claude/worktrees/<agent>/`, oxlint
  loads that worktree's `oxlint.config.ts` as a nested config and fails on
  the second `anti-slop` registration (#84). A file of another repository,
  the private `plans/` nested in the project or one a symlink in it points
  to, is not rewritten.
- Per-edit cost, measured on 2026-09-14 with hyperfine on `stop-gates.ts`
  (124 lines, clean), oxlint 1.82.0, oxfmt 0.67.0, 16 threads: 309 ms, the
  same in an agent worktree. Formatting alone took 58 ms.
- The Stop and each subagent's SubagentStop are the agent-hooks kit's
  (`agent-hooks/`, wired by its plugin; the machine's global hooks wire the
  Stop only): `.claude/agent-hooks.jsonc` gives it one `project` lane,
  `scripts/run-gates.ts`, run when the scope is not empty. The main session's
  scope is the files changed since SessionStart's photo of the tree; a
  subagent's, those changed since its first Edit or Write, on its own state
  keyed `<session>.<agent_id>`; any writer, `.claude/worktrees/` excluded.
  Each root the session or the subagent photographed is checked, wherever its
  `cwd` went. The kit blocks while the agent makes progress on the failing
  set, at most 3 times in a row, skips plan mode, skips the main session's
  Stop while a subagent, workflow or teammate runs, and caches a green run by
  HEAD and dirty tree. Its contract is the plugin's (`agent-hooks/skills/`).
- A new gate is one `EXPECTED_COMMANDS` entry in
  `scripts/check-lint-config.ts`. `lint-config` then demands its pre-commit job
  and its CI step; Stop and pre-push run it through `run-gates.ts`. A hooks
  module's `validate-<plugin>` and `test-<plugin>` are no entries:
  `expectedCommands` derives them from each catalog plugin whose
  `hooks/hooks.json` names `modules`. `run-gates.ts` runs a module's two only
  when the change reaches its directory (`kitsOf` in `scripts/affected.ts`),
  every module's with `--all`; parity still demands them all.
  The exception is a check of what a push moves: the release guard,
  `scripts/check-plugin-bumps.ts --pre-push`, on a push to `main`, and the
  e2e gate, `scripts/check-e2e-green.ts`, on a push to `dev`, are each one
  line of `.lefthook/pre-push/gates-and-tests.sh`, fed git's pushed-ref
  lines. As an entry the release guard would run at every Stop and on every
  push, red from each plugin change to its release-time bump; the e2e gate
  needs the network and an `e2e` run that already happened.
  `checkCommandParity` reads only the pre-commit `run` lines and CI's
  `validate` steps, so those lines need nothing there.
- Tests stay out of Stop: every suite takes about 36 s here in its two
  tiers (16 threads, `docs/repo-ops/checks.md`, Test tiers), the gates a few
  seconds without a kit.
  pre-push and CI run them, pre-push only the suites the change reaches
  (`scripts/affected.ts test`).

Known ceilings:

- Claude Code still adds its own "likely a formatter" note to each rewrite,
  right after the diff.
- The rewrite is two formatting passes around one fix pass, not a fixed
  point. `oxlint --fix` skips a fix that overlaps another
  (`no-negated-condition`, then `no-else-return` on one `if`), and the last
  oxfmt pass can create a finding: both wait for Stop.
- A diff over 10,000 characters reaches the agent as a file path and a
  preview: Claude Code caps hook output there.
- A subagent that changes files through Bash alone, before any Edit or
  Write, has no photo, so its SubagentStop checks nothing; pre-commit and
  pre-push still check.
- A main session that commits its change before the end of its turn leaves
  an empty scope: a commit adds nothing to it, so the kit runs no lane;
  pre-commit already ran the gates.
- The kit's green cache keys a lane on HEAD and the dirty tree's digest, not
  on `origin/dev`: a fetch that moves `origin/dev` with no new commit or edit
  reuses a green `gates` result although the kits `run-gates.ts` would now
  reach may differ. pre-push runs them again.
- The kit's scope excludes `.claude/worktrees/`, so the main session's edits
  inside an agent worktree are not checked at its Stop. pre-commit and
  pre-push still check them.
- The gates run repo-wide, the kits as far as the checkout's change since
  its merge-base with `origin/dev` reaches, whoever made it. Red work of
  another session in the same checkout fails the lane: a session's scope
  holds another writer's files there too.
- `claude-code-types.ts` keeps its state in the checkout of the project's
  repository around the SessionStart `cwd`, climbing out of any other
  repository nested in it, else the project: `CLAUDE_PROJECT_DIR` stays the
  launching checkout by design, and `cwd` is the one field that follows
  EnterWorktree. It reads no ref: each installed version starts one run,
  whose fetch decides, and a version the trunk already carries ends as
  `skipped`.
- A non-isolated subagent shares its checkout with its parent and its
  siblings: its scope holds their changes made since its first edit, so a
  half-done edit of theirs can turn its lane red. The loop guard lets the
  same failing set through once the subagent stops progressing on it; a red
  left that way reaches the parent's Stop, and pre-commit and pre-push still
  catch it.
- pre-push's gates and tests check the working tree, not the pushed commits.
  Only the release guard, on a push to `main`, and the e2e gate, on a push to
  `dev`, read the pushed commits.
