---
name: gpg-sign-history
description: GPG-sign the unsigned commits of a repository's history behind a backup branch, keeping the author dates and proving that no content changed.
disable-model-invocation: true
allowed-tools:
  - Bash(git log:*)
  - Bash(git rev-list:*)
  - Bash(git config:*)
  - Bash(git verify-commit:*)
  - Bash(git branch:*)
  - Bash(git diff:*)
  - Bash(git rebase:*)
  - Bash(git -c core.hooksPath=/dev/null rebase:*)
  - Bash(gpg --list-secret-keys:*)
  - AskUserQuestion
---

# GPG-sign history

Re-sign the unsigned commits of the current repository by rebasing them under
`commit.gpgsign=true`. The rebase changes every SHA in its range, keeps each
author date and sets each committer date to its author date; a backup branch
holds the old history until the user drops it.

## 1. Signature dates

A signature carries its own creation time, and every signature this rewrite
makes is dated today. The author dates stay, and GitHub shows `Verified`
beside them, but `git verify-commit --raw <sha>` prints the
signature's date: anyone who inspects a re-signed commit sees when it was
signed. Re-signing fits a key rotation, a security cleanup, or a project that
requires a signed history. For a user who only wants old commits to show
`Verified`, recommend Stop: the badge costs a new SHA for every commit in the
range and a force-push, and anyone who checks sees the signatures were made
today.

Before the repository changes in any way (config, branch, rebase), explain this
and ask through `AskUserQuestion`, which records the choice; a reply in chat is
not that record. Three options:

- **Audit only**: step 2, then the report; the history stays as it is.
- **Continue signing**: the whole procedure, signatures dated today accepted.
- **Stop**: nothing changes; the history stays as it is.

## 2. Audit

Read-only. Establish:

- the unsigned commits (`%G?` is `N` in `git log --format='%h %G? %s'`), their count, and the total (`git rev-list --count HEAD`);
- a secret key (`gpg --list-secret-keys --keyid-format long`), `user.signingkey` and `commit.gpgsign`;
- the visible timeline: `git log --format='%h %ai %ci %G? %s' -10`;
- for one commit already signed, the `VALIDSIG` line of `git verify-commit --raw <sha>`. The date after the fingerprint, and the epoch after that date, are the signature's creation time, not a Git date. Show the user.

No unsigned commit: say so and stop. **Audit only**: report the count, restate
the date tradeoff, and stop.

## 3. Range

Unsigned commits forming one block at the tip: `HEAD~<M>`, where M reaches the
oldest of them. Unsigned commits scattered through the history: `--root`. A
range that holds merge commits takes `--rebase-merges` as well; a plain rebase
drops them and flattens the history.

Ask once more through `AskUserQuestion`, naming the range and the number of
commits it rewrites: every SHA in it changes, and every commit in it, signed
ones included, gets a new signature from the user's key dated today.

## 4. Rewrite

1. `commit.gpgsign` not `true`, or `user.signingkey` unset: set them in the repository config. The rebase signs through them.
2. `git branch backup/pre-gpg-resign`
3. `git rebase --committer-date-is-author-date --autostash <range>`

`--committer-date-is-author-date` copies each author date into the committer
date and implies `--force-rebase`, so every commit in the range is recreated and
signed through `commit.gpgsign`. Without it, GitHub shows each rewritten commit
as committed just now. Leave out `--exec 'git commit --amend -S'`: the pick
already signs, and `--amend` resets the committer date to now, which the flag
does not reach.

A rebase runs the `prepare-commit-msg` and `post-commit` hooks once for every
commit it recreates. Where either is installed, in `.git/hooks` or through a
manager such as lefthook or husky, run that one rebase as
`git -c core.hooksPath=/dev/null rebase ...`.

A rebase that stops on `gpg failed to sign the data`: run `git rebase --abort`,
then ask the user to unlock the key. Its passphrase prompt needs a terminal or
a desktop pinentry, and the Bash tool offers neither.

## 5. Verify

All five pass before anything is pushed:

1. `git diff backup/pre-gpg-resign HEAD` prints nothing: no content changed.
2. `git log --format='%h %G?'` shows no `N`.
3. `git log --format='%h %ai %ci' HEAD~<M>..HEAD` (the whole log after `--root`) shows the same date twice on every line.
4. `git log --show-signature -5` shows good signatures.
5. `git verify-commit --raw <new SHA of a rewritten commit>`: the `VALIDSIG` date is today, as expected.

A failed check: report it, push nothing, and give the restore,
`git reset --hard backup/pre-gpg-resign`.

## 6. Report

State that the author dates are preserved, that each committer date now equals
its author date, and that the GPG signatures date from this rewrite. Then:

- a branch with a remote needs `git push --force-with-lease`, since every SHA in the range changed; the user runs it;
- `git branch -D backup/pre-gpg-resign` drops the backup once the history looks right;
- GitHub shows `Unverified` until the public key is uploaded: `gpg --armor --export <email>`, pasted at GitHub > Settings > SSH and GPG keys.
