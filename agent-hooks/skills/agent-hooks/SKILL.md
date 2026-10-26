---
name: agent-hooks
description: Set up or check the agent-hooks kit in a repository (the session-scoped fixers and Stop lanes this plugin wires, and its landing guard on Bash). Use when the user asks to add hooks to a repo, to init agent hooks, to run the hooks doctor, to declare how a repository lands, whether its tasks take their own worktrees or whether Haiku judges agent commit messages (commit judge), to measure what the hooks inject into the context (noise), when a Stop hook misbehaves (blocks on the wrong files, never blocks, names a missing tool), or when the landing guard refuses a push, a merge or a release.
argument-hint: "[init|doctor|noise]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/agent-hooks.ts *), Read(~/.claude/plugins/cache/*/agent-hooks/*/presets/**)
---

# agent-hooks

The kit is this plugin, run as `${CLAUDE_PLUGIN_ROOT}/agent-hooks.ts`. Its `hooks/hooks.json` wires
Claude Code wherever the plugin is enabled. Codex has no plugin: its own hook config calls the same
entry with `--harness codex`, through `~/.local/bin/agent-hooks`, a symlink to the entry in a checkout
that does not move with the plugin's version. A repository opts in with one file,
`.claude/agent-hooks.jsonc`; without it the kit runs only its landing guard. Never copy kit code into a repository and
never redeclare its hooks in a `.claude/settings.json` or `.codex/config.toml`: a hook declared at two
levels runs twice.

A key the kit adds lands in two steps: first the kit's version that reads it, then the repository's
file, once the plugin installed where the repository's agents run is at that version (a catalog that
installs on landing, after it has). An older kit refuses the unknown key: its Stop fails on the file
and, for a key under `profile`, a kit before 1.4.0 also refuses every door in a checkout holding it, its
landing guard reading the whole profile; from 1.4.0 the guard reads `profile.landing` alone.

## init

1. From the repo root, run `${CLAUDE_PLUGIN_ROOT}/agent-hooks.ts init --print` and show the JSONC it
   prints. It picks the presets from what the tree holds: `ts` for a `package.json`, `rust` for a
   `Cargo.toml`, `shell` for `*.sh`; it disables the `typecheck` and `test` lanes when the root
   `package.json` has no such script.
2. Read the presets it names under `${CLAUDE_PLUGIN_ROOT}/presets/` and say in two lines what
   runs before each write (fixers) and at Stop (lanes). Adjust with the user: a lane to disable
   (`"<lane>": { "disabled": true }`), a timeout, a `verdict: "note"` for a lane that must inform without
   blocking, `pre-edit.exclude` globs for generated or vendored trees (never fixed, never handed to a
   `files` lane; a `project` lane still runs when they change).
3. Ask for the user's agreement, then write `.claude/agent-hooks.jsonc` (the kit never writes it).
4. Run `${CLAUDE_PLUGIN_ROOT}/agent-hooks.ts doctor` and fix every `MISSING` line (a tool absent from
   `node_modules/.bin` and PATH, a `bun run <script>` with no such script) before the first turn.
5. Summarize: the file written, the lanes that will block, the ones that only note.

## doctor

Run `${CLAUDE_PLUGIN_ROOT}/agent-hooks.ts doctor` from the repo root (or `--config <file>` to check
another config in this root). It prints the merged config, one line per fixer and lane with the resolved
binary or `MISSING`, the wiring of each harness, the photo timing, the last Stop of the root and a full
`verify`. Explain each `MISSING` and `WARN` to the user and propose the fix: install the tool, add the
script, or disable the lane. For the wiring:

- `WARN claude wiring: no agent-hooks Stop hook`: the plugin is not enabled; enable it, never add the
  hooks to a settings file.
- `WARN claude wiring: plugin ... and a hook in ...`: both run the kit; remove the hook from that
  settings file.
- `WARN claude wiring: ... wires the Stop but no SubagentStop`: the kit runs from a settings file that
  gates the main session only; enable the plugin, which wires both, and remove those hooks.
- `WARN codex wiring`: the Codex config calls no `agent-hooks stop --harness codex`; only a user who
  runs Codex needs it.
- `MISSING checkout: ... is outside git`: the root lies in no git work tree, so the kit photographs
  nothing and the Stop checks nothing there, silently; the doctor is the one place that says so.

Exit 1 means at least one `MISSING` or a failing lane.

## noise

`${CLAUDE_PLUGIN_ROOT}/agent-hooks.ts noise [--days N]` (default 7) reports what the kit's hooks put in front
of the agent and the user, from the Claude Code transcripts under `$CLAUDE_CONFIG_DIR/projects` (default
`~/.claude/projects`), each subagent's included, written in the window. A transcript counts when one of its
cwds lies under a root holding `.claude/agent-hooks.jsonc`, looked up now: a removed worktree counts for
the root above it, and the landing guard's refusals in a repository without that file are not counted. It
prints aggregates only, never a line of a transcript:

- per hook event and channel, the count and characters of `additionalContext` and block reasons, which
  reach the agent's context, and of `systemMessage`, which Claude Code shows the user;
- the kit's Stops and SubagentStops that passed, blocked, were cancelled or errored;
- per lane, the Stop reports that carried a section of it and its characters, read in the shape the kit
  writes a report: its header line, then `### <lane>` or `### <lane> [<pkg>]` after a blank line, up to
  the section's own blank line (the kit drops the blank lines of a lane's output); the header, a nested
  root's label, the instruction and the kit's own lines outside a section go to `(no lane)`.

Each output is read once, from the one record Claude Code writes for it that names the hook, as measured
on the local transcripts (Claude Code 2.1, the 30 days to 2026-10-17): a hook's stdout in its
`hook_success`; a Stop block in its `hook_blocking_error`, with no `hook_success` beside it (27 kit Stop
blocks of 7 days); a pre-bash refusal in the tool result Claude Code replaced, a string that starts
`PreToolUse:<tool> hook error: agent-hooks:` (every one of 20 hook denials). A subagent's records are in its
own transcript only (2,480 hook records over 1,299 subagent transcripts, none in a parent's). The kit is
known by a command running one of its subcommands or by a `statusMessage` of `hooks/hooks.json`, which
Claude Code records in place of the command. The `hook_system_message` and `hook_additional_context`
records repeat a stdout without naming its hook and are not read. Codex transcripts are not read.

## Worktrees

`"profile": { "worktree": "per-task" }` says each task takes a worktree of its own; `"shared"`, the default,
says the agents share the checkout. Like `landing`, it is read from the repo file only. An invalid value is
a note to the user at SessionStart and an error of the config at the Stop and in `doctor`; the landing
guard, which reads `profile.landing` alone, is not affected.

Every kit hook (SessionStart, pre-edit, pre-bash, Stop, SubagentStop) beats for its agent in the checkout
around its cwd, when a root encloses it: it refreshes the mtime of
`~/.local/state/agent-hooks/<agent>__<checkout hash>.beat`. SessionEnd, `/clear` included, removes the beats
of the session and its subagents. Under `per-task`, a SessionStart whose source is `startup` or `clear`
(never `resume`, `compact` or `fork`: a session mid-task is not told to move) adds one line of
`additionalContext` naming its checkout when another session (its subagents included, never this session's
own) beat there in the last 15 minutes, and tells the agent to work in a worktree of its own
(EnterWorktree, or `git worktree add`). It never blocks. 99.2% of the gaps between two hook runs of one
session or subagent ran under 15 minutes (67,849 gaps over 1,185 transcripts in roots holding the config,
local transcripts, the 30 days to 2026-10-17; p95 2.1 min, p99 11.9 min). So a session that leaves a
checkout ages out there in 15 minutes, a live session idle longer reads as gone, and a session that ended
without its SessionEnd (a crash, a kill) reads as live for up to 15 minutes. SessionEnd hooks share Claude
Code's 1.5-second budget, which a plugin's own `timeout` does not raise
([SessionEnd](https://code.claude.com/docs/en/hooks#sessionend)); `session-end` ran in 98 to 118 ms over 200
beats (10 runs, bun 1.4.3, Linux, 2026-10-17). The SessionStart payload names no session that `/clear`
replaced, so the new session relies on the replaced one's SessionEnd having run first; that order is not
measured, and a SessionEnd that ran late or not at all costs one needless worktree line, never a block.

## Commit judge

`"profile": { "commitMessages": "judged" }`, read from the repo file alone, has `pre-bash` ask Haiku about
the message of each commit an agent runs in that repository, before the commit runs. A commit message says
what the code does and why, the reason in words; how the change came about and how it was checked go in the
pull request.

- What is judged: a `git commit` written as such, in a subshell too, that writes a message (`-m`, the
  heredoc `-F -` reads, or the file `-F` names), its `--trailer` values with it, an amend that writes one
  included, once the landing guard let the line through (its refusal wins, and nothing is judged). A
  message only the line's run gives goes unjudged with a note, since the hook runs before the line: a value
  Bash expands (`-m "$MSG"`, `-m "$(cat msg.txt)"`, backticks; a heredoc read through `$(cat <<'EOF' …)`
  is literal), a `-F -` fed by a pipe or by a heredoc Bash expands, a `-F` file whose name the line names
  before the commit. Not judged: a commit that keeps or reuses a message (`--no-edit`, `-C`,
  `--fixup=amend:`), one that makes none (`--dry-run`, `--porcelain`, `-h`), a commit inside `$(…)` or
  backticks, behind `xargs` or `env -S`, in a `bash -c '…'`, on a line that defines a function; a commit
  whose `cd` the walk cannot follow and that no absolute `git -C` places (with a note); `merge`,
  `cherry-pick`, `revert`, `rebase`; every other command.
- Haiku runs as `claude -p --model haiku`, with no tool, hook, MCP server or saved session, given the
  message, then the files the commit takes, on stdin: the index (`git diff --cached --name-only`), or the
  tracked changes on disk for `-a` and pathspecs (`git diff --name-only HEAD`), read before the line runs;
  the commits of one line at once. It lists each passage that could break the rule with a kind, and the kit
  refuses when one is `process` (the change explained by what produced it: a review and its findings, a
  session, a lead's decision, a plan label) or `check-event` (a check reported as an event: a test seen
  red, before and after numbers, a run id, a statistic given to justify a choice), and its quote is in the
  message, whitespace aside. A bare `#N` passes. `JUDGE_PROMPT` in `commit-judge.ts` is the prompt measured: a change to it is measured
  again before it lands.
- A refusal is a PreToolUse deny whose reason starts with `agent-hooks:`, quotes each passage, and gives
  both ways out on the same footing: rewrite these passages, or rerun exactly the same command when the
  message is right. A refusal holds once per message: `~/.local/state/agent-hooks/<agent>.refused` keeps
  the hash of each message refused to that agent, and that message committed again unchanged passes
  unjudged from then on, a rerun that a red pre-commit or a denied prompt stopped included. It ages out
  with the beats. A refusal the kit cannot save lets the commit through, with a note: its rerun would be
  judged again. A refusal carries the notes of the line's other commits. `noise` counts these refusals with
  the landing guard's.
- Haiku with no answer (no `claude` on PATH, an error exit, an unreadable answer twice, no time left before
  the hook's deadline) lets the commit through, with a `systemMessage` that starts with `agent-hooks:`. A
  commit Haiku passes is silent. Each judged commit waits for Haiku's answer, after the landing guard's.

## Reading a Stop

The Stop measures checkouts (git work trees); roots only check. Each fact has one owner:

- Photo: one per agent and checkout, the dirty tree when the agent first reached it. Taken at
  SessionStart for the checkout around the cwd, when a root encloses the cwd; at the first Edit or
  Write (Claude) or the first `apply_patch` (Codex, whose hook runs after the write, so the patched
  files count as changed; a patch spanning several checkouts photographs each) for any other
  checkout. `resume` and `compact` keep it. Paths are read with their symlinks resolved, as git names
  them.
- Changed files: in each photographed checkout, the dirty files whose content differs from the photo.
  For the main session only, the checkout around its cwd counts without a photo, over its whole dirty
  tree (Bash and a Codex patch photograph nothing); the Stop says so in a note. A checkout left without
  a photo is measured only while the cwd stands in it.
- Owner: each changed file goes to its nearest root holding `.claude/agent-hooks.jsonc`, the rule
  pre-edit uses, computed once over every changed file. The roots owning at least one file run their
  fixers and lanes on their own files, each under its own config; a nested root's file never reaches
  the outer root's lanes. A report names its root unless that root is the one around the cwd.
- Brake: one per agent and checkout. It blocks while the agent makes progress on the checkout's
  failing set (a changed set, or fewer diagnostic lines on the same set), at most `stop.cap` times in a
  row (default 3; the smallest cap of the failing roots); otherwise it lets the turn end with a
  `systemMessage` that starts with `agent-hooks:`. A checkout without a photo blocks once per failing
  set. Nothing to fix in the kit when that message shows: the agent stopped progressing.
- Verdict: the Stop blocks if any brake blocks.
- `${CLAUDE_PLUGIN_ROOT}/agent-hooks.ts verify [--all] [files...]` runs the lanes now, without the green
  cache, and prints one line per lane, on the files this root owns among those the last main session
  changed in the checkout. `--all` takes the whole dirty tree instead; named files run as named.
- A subagent's SubagentStop is measured the same way on its own states: the checkouts its own Edits or
  Writes photographed, under its own brake. Its cwd's checkout is not added, so a subagent that edited
  nothing is let through. The main session's Stop waits while a subagent, workflow or teammate still
  runs.
- State: `~/.local/state/agent-hooks/<agent>__<checkout hash>.json`, `<agent>` the session id or
  `<session>.<agent id>` for a subagent: the photo, the brake, and per root its green keys and
  `lastRun.lanes`; pruned after 7 days, as the agent's `.beat` beside it (see Worktrees).
- Pre-edit fixes a copy of the new content in `.agent-hooks-XXXXXX/` beside the file, so the fixers find
  the config and the overrides of the real path. The kit's own scope never counts that copy, but another
  tool watching the tree can see it while the fixers run, and a pre-edit killed past its deadline leaves
  it until the next SessionStart, which removes the untracked directories of that exact name, holding no
  tracked file, older than the pre-edit deadline. A path that merely starts with `.agent-hooks-` is the
  repository's own.

## Ceilings

What the model bounds and the kit does not try to cross:

- The photo bounds what is measured, not who wrote it. Concurrent agents in one checkout see each
  other's changes since their own photo: a subagent can block on a sibling's file, and its Stop fixers
  rewrite it.
- With no root around the cwd, SessionStart photographs nothing, as without a config, and a nested
  root gets its photo at the first Edit, Write or `apply_patch` under it. Bash-only writes under a
  nested root, with no root around the cwd, go unchecked.
- A state file of another version reads as absent, and the kit carries no compatibility code: after a
  change of the state's version, the running sessions lose their photos. The cwd's checkout is then
  measured over its whole dirty tree at the next Stop, where dirt that predates the session can block
  once per failing set, and the other checkouts go unchecked until an edit there photographs them
  again; the changes made before the change of version are not measured.
- A root outside git has no checkout: nothing is photographed and nothing is checked there. `doctor`
  says so; the Stop does not.

## Landing guard

- `pre-bash`, a PreToolUse hook on Bash, runs in every repository, with or without
  `.claude/agent-hooks.jsonc`. It first reads the raw text, line continuations joined, for a door:
  `push` after `git` or a git alias that pushes, `merge` after `gh`, `gh api` on `git/refs` or a merge
  endpoint, a GraphQL `mergePullRequest`, `mergeBranch`, `updateRef` or `deleteRef`, `release` after
  `gh`, a `scripts/release` path (with or without extension), a `package.json` script that runs one of
  them in a manifest the line can reach; where a repository the line names (its cwd, a `cd`, `--cwd`,
  `--prefix` or `-C`) declares `profile.approvals`, also `workflow`, `dispatches`, `--add-label`,
  `--label`, `-l`, `labels`, `labelIds` or `addLabelsToLabelable` after `gh`. No mention, the command passes unparsed.
- Each mention is then accounted for. Inert: text inside a quoted argument or a heredoc body of a
  command that does not run it (a commit message, `echo`, `rg`, an interpreter heredoc that calls no
  process API), an argument of a command that only reads it (`git log`, `cat`, `oxlint`). A door: an
  invocation whose deciding words are literal at hook time, the variables the line assigns a literal
  once, unconditionally, included, run where the guard can follow (`cd` to an existing directory,
  `git -C`, `env -C`, `sudo`, `nice`, `timeout`, `time`, `flock <lock> <command>`,
  `systemd-run --scope`, `mise exec --`, a literal `bash -c '…'`), with no earlier change in the same
  line to what it reads (`git checkout`, `git switch`, `git rebase <upstream> <branch>`,
  `git worktree add`, `git remote add`, a config write, a `cd` the guard cannot follow). Anything else
  is unresolved: a word known only at run time, a wrapper that hides its command (`xargs`, `env -S`,
  `flock -c`) or that the guard does not read (`stdbuf`, `watch`, `npx tsx`), a shell fed a heredoc
  or a pipe, an unquoted heredoc that runs `$(…)`, interpreter code that starts a process, `eval`, a
  shell function, a git alias or a `git -c` that moves the push, a GraphQL mutation. An unresolved
  mention is refused, naming the explicit form to use: `git push origin <branch>` alone from the
  repository, `gh pr merge <number>`, or, for a release, `bun ./scripts/release.ts --dry-run`.
- A repository whose agents land on their own declares its branches in its own file:
  `"profile": { "landing": { "trunk": "dev", "release": "main" } }`, never read from a preset, and read
  alone: an error elsewhere in the file leaves it in force. A resolved door is then refused when it
  pushes to `release` (a deletion, `--all` and `--mirror` included), force-pushes or deletes `trunk`,
  merges into `release`, merges with a check red, running or none reported (`--auto` included: gh
  merges a mergeable pull request at once), merges a pull request that is not mergeable, or runs
  `gh release create` or `scripts/release` (its `--dry-run` passes). `gh api` is judged as what it
  does: `PUT pulls/<n>/merge` as `gh pr merge <n>`, a ref update, deletion or `merges` call as a push.
  The checks are the newest run per name, workflow and event, as `gh pr checks` keeps them. A push
  without refspec goes where `@{push}` says, the current branch when git cannot tell. Each refusal
  names the way through: push to `trunk`, or `bun ./scripts/land.ts <branch>` when the repository has
  that script. A file that does not parse, or an invalid `profile.landing`, refuses every door there, naming the
  error.
- `"by": "action"` in `profile.landing` (default `"agent"`) says a server-side action moves `trunk`,
  fast-forwarding it to the head of a pull request whose run is green. Every push to `trunk` is then
  refused too, a `gh api` ref update or `merges` call included, and so is `gh pr merge` into `trunk`:
  the way through is the task branch, pushed, with its pull request open against `trunk`.
- `"profile": { "approvals": { "workflows": { "<file>.yml": ["<phrase>", …] }, "labels": { "<label>": ["<phrase with {pr}>", …] } } }`,
  read from the repo file alone like `landing`, names the doors that open only on the human's own
  words. A dispatch of a listed workflow (`gh workflow run <workflow>`, the workflow named by its file,
  its `.github/workflows/` path or the `name:` its file declares, or `POST
  repos/<owner>/<repo>/actions/workflows/<file>/dispatches` through `gh api`) passes only when the
  human's latest typed message holds one of its phrases. A listed label added to pull request `N`
  (`gh pr edit N --add-label`, `gh issue edit N --add-label`, `POST` or `PUT
  repos/<owner>/<repo>/issues/N/labels`, `PATCH repos/<owner>/<repo>/issues/N` with `labels`) passes
  only when that message holds one of its phrases with `N` in place of `{pr}`, for each `N` the command
  names (`gh issue edit 12 13`); one added with no literal number (`gh pr edit` alone, a branch,
  `gh pr create --label`) is refused, and so are a GraphQL `labelIds` or `addLabelsToLabelable`, and a
  dispatch or label endpoint the guard does not read (`repositories/<id>/…`), whatever the message. A phrase matches
  as whole words, any case, any run of whitespace between them, and nothing reads around it: `pas ok
  #12` holds `ok #{pr}`. The message is the latest one the human typed in the session's transcript, a
  message queued while the agent worked included, read from the main transcript in a subagent too; a
  task notification, a tool result, a peer session's or a teammate's message and an approved plan are
  not typed (`readHuman` in `transcript.ts`). A transcript that cannot
  be read, or does not yet hold the turn's prompt, refuses. A workflow named by its numeric id is
  refused, since the guard cannot match it to a file. A door whose `--repo` or endpoint names the
  repository of the hook's cwd is judged by its profile wherever the line `cd`s; one that names
  another repository is left alone, and an invalid `profile.approvals` refuses these doors,
  naming the error. A prompt suggestion the human accepted counts as typed. Not gated: a rerun of a
  past run of a listed workflow (`gh run rerun`, `actions/runs/<id>/rerun`), whose workflow the guard
  cannot tell without asking GitHub.
- `"profile": { "review": { "risky": ["<glob>", …] } }` names the paths whose change lands only with a
  clean review verdict for that exact change. The kit validates the list and enforces nothing with it:
  the repository's own land script reads it. A glob is relative to the repository root, as git names a
  path, so one that starts with `./` or `/` is refused; `doctor` warns on a glob that matches no tracked
  file (`WARN    review: risky glob …`), which guards nothing.
- Without a profile, a resolved push, ref move or merge to the default branch of a public repository is
  refused. The visibility and the default branch come from `gh repo view`, read once per repository and
  session into `~/.local/state/agent-hooks/github__<session>.json`. A lookup that fails, a call past
  its 25 s deadline, or a crash lets the command through with a `systemMessage` that starts with
  `agent-hooks:`. A remote that names no `host/owner/name` (a local path) is not checked.
- The profile and the package scripts are read where the walk reached (after `cd`, `--cwd`, `-C`); a
  release command or a door script whose directory the guard cannot follow is unresolved. `gh --repo`
  and a `gh api` endpoint keep the cwd's profile when they name its `origin`, and take the default
  otherwise. A release command is a door only in a repository with a profile.
- Known ceilings, let through, each counted in the local transcripts (74,687 Bash calls): a release
  script named from its own directory (`cd scripts && bun release.ts`, 0), a wrapper the guard does not
  know around a quoted command (`chronic sh -c '…'`, `direnv exec . bash -c '…'`, 0), a heredoc fed to
  `ssh` (1), a script written then run (`cat > x.sh <<EOF … git push … EOF; bash x.sh`, 1), git's
  dashed `git-push` (0), a keyword split by quotes (`git pu''sh`, 0), a GitHub API client other than
  `gh` (`curl …/merge`, 0), a package script reached in a manifest no `cd`, `--cwd` or `-C` of the line
  names, a gh alias. The Codex wiring calls no `pre-bash`.
