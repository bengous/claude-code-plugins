---
name: adversarial-review
description: Adversarial review by Codex (OpenAI) of local git changes, either the uncommitted work or the current branch against a base ref, with optional focus text. Codex runs read-only; each finding names a file, a line range and a concrete fix, and the review ends with a SHIP or NO-SHIP verdict. Use when the user asks Codex to review, challenge or attack their uncommitted changes, their diff or their branch before shipping.
argument-hint: "[--base <ref>] [-m <model>] [focus ...]"
allowed-tools:
  - Bash(git status *)
  - Bash(git rev-parse *)
  - Bash(git diff *)
  - Bash(${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts *)
  - Read(./**)
  - Read(~/.cache/agents-bridge/**)
  - Edit(~/.cache/agents-bridge/review/**)
---

# Adversarial review of local changes

Codex tries to break confidence in a git change: it looks for the strongest
reasons the change must not ship. The review is read-only. This skill edits
no file; fixing a finding is a separate request.

The diff and the untracked files it lists go to OpenAI. Stop and ask when an
untracked file looks like a secret or a dependency tree.

For a proposal that lives in the conversation, not on disk, use `critique`.

## Workflow

1. **Parse the arguments.** `--base <ref>` selects the branch diff against
   `<ref>`; without it, the target is the uncommitted work (staged, unstaged,
   untracked). `-m <model>` selects the Codex model. Everything else is the
   user's focus text, kept verbatim. `<ref>` and `<model>` go into commands
   inside single quotes, as written below.

2. **Check that the target is not empty.** A Codex run on nothing wastes
   minutes, so stop here with the reason when a check fails.
   - Uncommitted: `git status --short --untracked-files=all` must print at
     least one line. When it prints nothing, suggest `--base <ref>`.
   - Branch: `git rev-parse --verify --end-of-options '<ref>'` must succeed,
     and `git diff --shortstat '<ref>...HEAD'` must print a line. Also run
     `git status --short`: when it prints lines, tell the user that this
     uncommitted work is outside the review.

3. **Create the run directory.** Use the printed path literally in every
   later step: shell variables do not survive between Bash calls.

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" new review
   ```

4. **Write the prompt** with the Write tool to `<dir>/prompt.md`. User text
   goes in this file, never inline in the shell command: quotes and backticks
   break it.

   ```markdown
   Run an adversarial code review. Read ${CLAUDE_PLUGIN_ROOT}/skills/adversarial-review/prompt.md
   and follow it exactly.

   ## Target

   uncommitted            <- or: base <ref>

   ## Focus from the user

   <focus text verbatim, or: none>
   ```

5. **Run Codex read-only** from the repository under review. When the user
   passed `-m`, add `-m '<model>'` at the end.

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" start <dir> --prompt-file <dir>/prompt.md --role audit
   ```

   Run each `codex-run.ts` command alone, as written: a `;`, `&&` or `echo $?` added to it asks for permission, and the envelope's `status` already gives the exit code.
   A review at `xhigh` often outlasts the call's 540 s wait: exit 10 means
   Codex is still working. Repeat this until the exit code is no longer 10:

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" wait <dir>
   ```

   The turn runs in a detached process and survives the end of your turn,
   but its result is only relayed if you are still waiting for it. Exit 1, or
   no `--- final message ---` section, is a failed run: report the
   envelope's `error` and show no review.

6. **Relay, then verify.** Show the final message verbatim. Then check each
   finding by reading the code with the Read tool and name the ones that do
   not hold. Do not run the code: an import or a test run writes into the
   repo (`__pycache__`, build output). When the `Verdict:` line is missing,
   say so; never write one for Codex.

## Defaults & overrides

- Role `audit`, sandbox read-only, unless the user passes `-m`. Change the
  effort (`--effort <level>`) only when the user asks.
- The run directory is kept: the thread id in `run.json` is what a follow-up
  resumes.
- To push back on a finding, write the objection to `<dir>/pushback-2.md`,
  then resume the thread; resume replays the first turn's model, effort and
  sandbox. The `allowed-tools` grant covers the invoking turn only, so a
  later turn may prompt.

  ```bash
  "${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" resume <dir> --prompt-file <dir>/pushback-2.md
  ```
