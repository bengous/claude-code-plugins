# secret-pane

A Claude Code mod that lets Claude use a secret it never sees. When a task needs an API key, a token or a password, Claude calls `request_secret`, a masked box opens beside the transcript, you paste the value, and Claude gets a placeholder such as `[secret-pane:PARENT_REPO_PAT:3f9a1c2e]`. The placeholder becomes the real value inside a Bash command written in one shape, and the value is hidden again in everything that comes back. The value lives in the session's memory alone: the mod writes nothing to disk, and nothing of it reaches what the model reads.

A value that reaches the conversation is in the transcript for good: sent to the model on every turn after, kept in the session file, replayed into every fork. The one fix is never to send it. secret-pane closes the ways in, a paste and a tool result that prints the value, and still lets Claude run the command that needs it.

## Install

```
/plugin marketplace add bengous/claude-code-plugins
/plugin install secret-pane@bengous-plugins
```

## Use

Ask for something that needs a secret: `set the PARENT_REPO_PAT secret on the three repositories`. Claude calls `secret-pane - request_secret` with the variable's name and a one-line reason.

- **Paste** the value into the box. It draws dots and a character count, never the text.
- **Enter** keeps it, trimmed. A value under 8 characters is not kept: the box says so and waits. A toast says when it is kept, and Claude gets the placeholder.
- **Esc** cancels. Claude is told, and nothing is kept.

Claude then writes the placeholder as a whole single-quoted word, in one command or one pipe of two:

```
printf '%s' '[secret-pane:PARENT_REPO_PAT:3f9a1c2e]' | gh secret set PARENT_REPO_PAT --repo org/repo
curl -fsS -o /dev/null -w '%{http_code}' --oauth2-bearer '[secret-pane:PARENT_REPO_PAT:3f9a1c2e]' https://api.github.com/repos/org/repo
```

Each runs with the real value in its place, shell-quoted, so a value holding spaces, quotes or `$` goes in as text. Whatever a command prints of a kept value comes back to Claude as its placeholder.

A command that names a placeholder is refused, with the reason, when:

- the placeholder stands anywhere but as a whole single-quoted word (`"..."`, inside a header, after `=`), or the session never minted it (an earlier session's, one from before a `/clear`);
- it holds `;`, `&`, `&&`, `||`, `$`, `(`, `)`, a backtick, `<`, a new line, or a second pipe;
- one of its commands is a wrapper that runs its arguments as another command (`sh`, `bash`, `env`, `xargs`, `eval`, `sudo`, `ssh`...), or a gh command other than `gh secret`: text that leaves the machine cannot be taken back;
- one of its commands is git with a subcommand outside the local ones, those that can neither write a message into history nor send text out (`status`, `diff`, `log`, `fetch`, `clone`, `add`, `config`, `credential`, ...; the list is `GIT_LOCAL` in `hooks/shell.ts`). An alias counts as unknown, so `git ci` is refused as `git commit` is. The refusal of `git push` says how to hand git the token instead, then push with no placeholder;
- it runs in the background: its output is written to disk and read back past the mod.

A Write, an Edit or a NotebookEdit whose text holds a placeholder of this session is refused too: the file would hold the placeholder where the value was meant. The refusal names the Bash command that writes the value, `printf 'NAME=%s\n' '<placeholder>' >> .env`, and says to write `NAME` to mention the secret without its value. A placeholder the session never minted is written as text, an example as in this README.

If you would rather not wait for Claude to think of the tool, say `use secret-pane to ask me for PARENT_REPO_PAT`.

## How it works

- `session.start` registers the tool with `isDeferred: false`, so Claude sees it on every turn.
- The box is a pane opened with `$.ui.open` and drawn with an `Input`. The element has no password mode, so the mod masks it itself: the field draws one dot per character held, and each change hands back the dots kept plus what was typed or pasted. An edit in the middle of the field cannot be read that way, so it empties the field and the box says why. A hook's own time is capped, and time inside a host call is not counted, so the mod waits for you in short `sleep` processes (`Start-Sleep` through PowerShell on Windows), up to ten minutes; whatever ends the wait, the box closes and the slot frees.
- On a terminal narrower than 144 columns Claude Code does not place a pane nobody asked for, so the box draws in the band above the prompt instead: press ctrl+x then tab to type in it; Enter on an empty field cancels.
- The vault maps each value to a placeholder that stays stable within the session, in the module's memory only; `session.start` and `session.end` (a `/clear` too) empty it. Every kept value is hidden in one pass, placeholders matched first so a value found inside one never rewrites it.
- Two layers hide a value on the way back. A `tool.call` hook on Bash, Read, Write, Edit, NotebookEdit, Monitor, GetTask and LSP hides it in the tool's record, which the session file stores, the file a Write replaced included; a result holding none comes back as it came. A `session.append` hook hides it in every row the model reads, whatever door it came by: a tool's result, a task's notification, a hook's context, a prompt. A `prompt.submit` hook hides it in a prompt and its context before they are queued. Measured in a live `claude -p` session with a probe mod: a `session.append` rewrite of a Bash result and of a background task's output reached the model, and the session file kept the raw `toolUseResult`, which only `tool.call` changes.
- While a value is kept, a Bash command that may commit or publish is checked before it runs, placeholder or not: one that names a git subcommand outside the local ones, or a gh subcommand other than `gh secret`, anywhere in its text, `sh -c "git commit ..."` included (`gh stack add -Am` commits). The body of a heredoc whose delimiter is quoted, the commit message of `git commit -m "$(cat <<'EOF' ... EOF)"` among them, is text, not commands, unless a shell on its line runs it (`bash <<'EOF'`). The mod finds the repository the command acts on: the `cd` and `pushd` commands before it, composed, after a keyword or a brace too, a subshell's left in it; or else the session's directory, which follows Claude's `cd`; with the `-C`, `--git-dir` and `--work-tree` it hands git, or the `GIT_DIR=` and `GIT_WORK_TREE=` in front of it. There it runs `git diff --cached` and `git diff` and searches the lines they add, then reads every untracked file git does not ignore; for gh, it also reads each file its arguments name (`gh gist create .env`, `--body-file=log`, `-F body=@notes.md`). It searches each value's longest line, so a key spread over lines is found by a line of its body, not by its header. A hit refuses the command and names each file with its fix: `.gitignore` for an untracked one; the value out, or `git rm --cached`, for a tracked one; the file left out for one handed to gh. A check that cannot read every change refuses too, saying why: no repository for git (gh outside any repository carries no change), a directory the command makes itself (`mkdir x && cd x && git init && git commit`), git failing, an output over 4 MiB, more than 1000 untracked files, a `cd` to a place the mod cannot read (`cd $DIR`, `popd`). The values never leave the mod: git prints the changes, and the mod searches them.
- The permission is decided on the command as it runs, value in. On a real call the mod restored, a `tool.check` hook on Bash reads the session's verdict first; where it would ask, the mod asks through `$.ui.ask` instead, the command as Claude wrote it on show, with Run it and Don't run it alone. A query of a permission is left alone.
- The hooks that guard fail closed: a check that breaks withholds the result or refuses the call, and a row whose check breaks reaches the model with its text withheld.

## Limits

- It hides what Claude reads, not what Claude does. With the placeholder, Claude can still run a command that transforms the value (`base64`, `rev`) or sends it to a host other than git and GitHub, and the transformed output is not recognized. This keeps a value out of the transcript by accident; it is no sandbox against a model trying to leak one.
- The command with the real value in it is what runs: a settings `PreToolUse` or `PostToolUse` hook receives it (measured in the kit: the `classic.PreToolUse` hook beneath the mod sees the restored command). The permission dialog does not, nor an "always allow" rule in `settings.local.json`: the mod asks instead. In auto mode too, on purpose: the classifier would read the value; you are asked instead. A settings rule or the mode that allows or denies the command outright is left to decide. Not measured in a live session: that the mod's question draws while the check waits; the kit raises no permission check on a real call.
- Only Bash gets the real value. Write, Edit and NotebookEdit refuse a placeholder of this session; a step that needs the value in a file is a Bash command that writes it (`printf 'NAME=%s\n' '<placeholder>' >> .env`), and the file then holds the value in clear.
- Tools outside the `tool.call` list of How it works keep a raw value in the record the session file stores, though the model reads it hidden. On Windows that includes Grep, which this build has only there.
- The check before a commit or a publish reads the changes as they stand before the command, never the history: a value committed by a way the mod does not see (a script, a subagent's worktree) is pushed with the rest, and so is a file the command itself brings in, `git add -f` of an ignored one or `cp .env.local config.env && git add -A && git commit`. It does not read a change to a tracked binary file, an untracked file over 4 MiB or a submodule either, nor a command run over ssh, which runs on another machine. It follows the session's `cd`, not a subagent's: a subagent's commit is checked where the session stands, unless its command `cd`s first. And since it reads the working tree, it refuses a push too while a value stands in a file not committed yet.
- To read the changes, the mod runs git in the repository the command names, before you are asked about the command: with no fsmonitor program, but a clean filter the repository's own `.git/config` sets runs, as it would on your own `git diff`. A clone brings no such setting; a repository unpacked from an archive can.
- The command is read as text, not as the shell runs it: a `git push` inside an `echo` is checked too, and a git reached through a variable (`$GIT commit`) or a place set by `export GIT_DIR=...` in an earlier command is not.
- The engine writes a background task's output to a file under its temp directory; a command holding a placeholder is refused in the background for that reason, but a command with no placeholder that prints a kept value in the background leaves it there.
- The vault is memory only: a hot reload of the mod, a new session or a `/clear` forgets every value, and a placeholder from before then refuses the command that names it. Claude asks again.
- One secret at a time: a second `request_secret` while the box is open is answered with a refusal, not a second box.
- `claude -p` has no one to type, and a session drawn on a phone alone has no box: the tool answers that it needs a terminal or a desktop.
- A paste can show for one frame before it is redrawn as dots.
- The box in a live terminal, the band fallback and the wait on Windows (`powershell -NoProfile -Command Start-Sleep`) are not measured.
- The wait spawns one short process every 0.3 s while the box is open, each a `process.run` other mods can see; a single process ended from the box would do with one, its abort not measured.

## Develop

```
claude --plugin-dir ./secret-pane
claude plugin validate secret-pane
claude plugin test secret-pane
bun test secret-pane
```

`hooks/register.test.ts` is the kit's suite: the box on the pane and in the band and what it refuses to keep, the placeholder in and out of Bash, the hiding in a later command's output, in a file read, in a Write's record and in a row any door appends, the refusals of commands and of file writes, `/clear`, the prompt and its context, what the settings hooks see. `hooks/shell.spec.ts` is the command allow-list and the reading of git and gh in a command, `hooks/scan.spec.ts` the check of the changes, on a fake host and on a real repository, `hooks/vault.spec.ts` the vault and the field.
