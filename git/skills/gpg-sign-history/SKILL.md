---
name: gpg-sign-history
description: GPG-sign the unsigned commits of the current branch behind a backup branch, keeping every tree, author and date, and checking each new commit against the one it replaces.
disable-model-invocation: true
allowed-tools:
  - Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gpg-sign-history.ts audit *)
  - Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gpg-sign-history.ts verify *)
---

# GPG-sign history

The plugin's backend does every mechanical step and prints one JSON object per
run. It finds the unsigned commits of the current branch and checks that the key
signs. It recreates each commit from the oldest unsigned one up to the tip, with
the same tree, parents, author, dates and message, and checks every new commit
against the one it replaces. Only then does it move the branch, behind a backup
branch of its own. This skill explains the tradeoff and asks the user twice.

## 1. Signature dates

A signature carries its own creation time, and every signature this rewrite
makes is dated today. The Git dates stay, and GitHub shows `Verified` beside
them, but `git verify-commit --raw <sha>` prints the signature's date: anyone
who inspects a re-signed commit sees when it was signed. Re-signing fits a key
rotation, a security cleanup, or a project that requires a signed history. For a
user who only wants old commits to show `Verified`, recommend Stop: the badge
costs a new SHA for every commit in the rewrite and a force-push, and anyone who
checks sees the signatures were made today.

Before anything runs, explain this and ask through `AskUserQuestion`, which
records the choice; a reply in chat is not that record. Three options:

- **Audit only**: step 2, then the report; the history stays as it is.
- **Continue signing**: the whole procedure, signatures dated today accepted.
- **Stop**: nothing runs; the history stays as it is.

## 2. Audit

```
run `"${CLAUDE_PLUGIN_ROOT}/scripts/gpg-sign-history.ts" audit`
```

On `ok: false`, report `error` and `detail` and stop. Otherwise report
`unsigned_count` out of `commits`, with the `unsigned` list, and
`sample_signature`: its `signed_at` beside its `committed_at` shows the date
tradeoff on the user's own history.

- `unsigned_count` is 0: say so and stop.
- `signing.ready` is false: give `signing.detail` and, for `key-locked`, the
  `signing.unlock` command, which the user runs in their own terminal; then run
  the audit again.
- **Audit only**: restate the date tradeoff and stop.

## 3. Second question

Ask once more through `AskUserQuestion`. The question text itself, not an
option's description, states each of these, leaving out a count of 0 and an
empty list:

- `rewrite.count` commits get a new SHA and a signature dated today, of which
  `rewrite.resigned` were signed already and `rewrite.merges` are merges;
- `rewrite.foreign_committers` commits made by someone else take the user as
  committer;
- the refs in `other_refs`, each named, keep pointing at the old commits;
- an `upstream` whose `rewritten` is true, named, needs a force-push.

## 4. Sign

```
run `"${CLAUDE_PLUGIN_ROOT}/scripts/gpg-sign-history.ts" apply`
```

On `ok: true`: `rewritten` commits, the new `head`, `backup_ref`, and `checks`.
On `ok: false`, the branch has not moved:

- `key-locked`: give `unlock`, which the user runs in their own terminal, then run `apply` again.
- `verification-failed`: report each entry of `checks.mismatches`, `checks.unsigned` and `checks.bad_signatures`.
- any other: report `error` and `detail`; `branch-moved` also names `backup_ref`.

## 5. Report

State that every author and committer date is preserved and that the GPG
signatures date from this rewrite (`signed_at`). Then:

- a branch with a remote needs `git push --force-with-lease`, since every SHA in the rewrite changed; the user runs it;
- `"${CLAUDE_PLUGIN_ROOT}/scripts/gpg-sign-history.ts" verify <backup_ref>` checks the branch against the backup again, before that push for instance;
- `git branch -D <backup_ref>` drops the backup once the history looks right;
- GitHub shows `Unverified` until the public key is uploaded: `gpg --armor --export <signing.key>`, the audit's key, pasted at GitHub > Settings > SSH and GPG keys.
