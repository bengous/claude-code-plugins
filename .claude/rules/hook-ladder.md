---
paths:
  - ".claude/hooks/**"
  - ".claude/__settings.jsonc"
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
  to, is neither rewritten nor marked.
- Per-edit cost, measured on 2026-09-14 with hyperfine on `stop-gates.ts`
  (124 lines, clean), oxlint 1.82.0, oxfmt 0.67.0, 16 threads: 309 ms, the
  same in an agent worktree. Formatting alone took 58 ms.
- Each in-repo Edit or Write empties the verdict of the editing agent's
  marker for the checkout that holds the file,
  `os.tmpdir()/claude-code-plugins-stop/<agent_id ?? session_id>.<hash of the
  checkout>`, a JSON `{ checkout, verdict }`. The same hook (`stop-gates.ts`)
  runs on Stop and on SubagentStop and runs `scripts/run-gates.ts` in each
  checkout the agent marked, never where its `cwd` sits: a `cd` into
  `plans/` must not gate the launching checkout in place of the worktree
  the agent edited. Green deletes the marker, and so does a checkout removed
  since. Red writes the verdict, the report's `Red gates:` line, into the
  marker and blocks, `stop_hook_active` or not. A stop with no edit since
  that block ends the turn on the same verdict, with a `systemMessage` note;
  a changed verdict blocks again. Plan mode skips both events; a background
  subagent, workflow or teammate skips Stop only. Claude Code ends a turn
  after 8 consecutive blocks.
- A subagent's payload carries the parent's `session_id` and its own
  `agent_id` (16 hex characters on 2.1.270), so keying the marker on
  `agent_id` first keeps the two independent: a green subagent run leaves the
  parent's mark, a parent verdict does not release a subagent. A SubagentStop
  payload lists the stopping subagent itself in `background_tasks`, which is
  why that skip does not apply there.
- A new gate is one `EXPECTED_COMMANDS` entry in
  `scripts/check-lint-config.ts`. `lint-config` then demands its pre-commit job
  and its CI step; Stop and pre-push run it through `run-gates.ts`.
  The exception is a check of what a push moves: the release guard,
  `scripts/check-plugin-bumps.ts --pre-push`, on a push to `main`, and the
  e2e gate, `scripts/check-e2e-green.ts`, on a push to `dev`, are each one
  line of `.lefthook/pre-push/gates-and-tests.sh`, fed git's pushed-ref
  lines. As an entry the release guard would run at every Stop and on every
  push, red from each plugin change to its release-time bump; the e2e gate
  needs the network and an `e2e` run that already happened.
  `checkCommandParity` reads only the pre-commit `run` lines and CI's
  `validate` steps, so those lines need nothing there.
- Tests stay out of Stop: the two `bun test` runs take about 30 s here, the
  gates under 3 s. pre-push and CI run them.

Known ceilings:

- Claude Code still adds its own "likely a formatter" note to each rewrite,
  right after the diff.
- The rewrite is two formatting passes around one fix pass, not a fixed
  point. `oxlint --fix` skips a fix that overlaps another
  (`no-negated-condition`, then `no-else-return` on one `if`), and the last
  oxfmt pass can create a finding: both wait for Stop.
- A diff over 10,000 characters reaches the agent as a file path and a
  preview: Claude Code caps hook output there.
- A write through Bash alone sets no marker, so that turn skips Stop;
  pre-commit and pre-push still check.
- The gates run repo-wide in each checkout the agent edited. Red work of
  another session in the same checkout blocks this session once per verdict.
- `regenerate-plugin-types.ts` checks the checkout of the project's
  repository around the SessionStart `cwd`, climbing out of any other
  repository nested in it, else the project: `CLAUDE_PROJECT_DIR` stays the
  launching checkout by design, and `cwd` is the one field that follows
  EnterWorktree.
- Skipping the background-task check for a subagent assumes no other listed
  task edits that subagent's checkout. That holds for an isolated subagent: it
  has its own worktree, and a nested one gets another. A non-isolated subagent
  shares its checkout with its parent, its siblings and any nested agent, so
  a half-done edit of theirs can turn its gates red; the unchanged-verdict
  release caps that at one block per verdict. A non-isolated subagent
  released that way leaves its red in the parent's checkout without a parent
  block; pre-commit and pre-push still catch it.
- pre-push's gates and tests check the working tree, not the pushed commits.
  Only the release guard, on a push to `main`, and the e2e gate, on a push to
  `dev`, read the pushed commits.
