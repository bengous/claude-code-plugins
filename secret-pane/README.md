# secret-pane

A Claude Code mod that lets Claude use a secret it never sees. When a task needs an API key, a token or a password, Claude calls `request_secret`, a masked box opens beside the transcript, you paste the value, and Claude gets a placeholder such as `[secret-pane:PARENT_REPO_PAT:3f9a1c2e]`. The placeholder becomes the real value inside a Bash command, and the value is hidden again in everything that comes back. The value lives in the session's memory alone: the mod writes nothing to disk, and nothing of it reaches what the model reads.

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

Claude then writes the placeholder in a Bash command where the value goes, as it would write the value:

```
curl -fsS -H "Authorization: Bearer [secret-pane:PARENT_REPO_PAT:3f9a1c2e]" https://api.github.com/user
printf '%s' [secret-pane:PARENT_REPO_PAT:3f9a1c2e] | gh secret set PARENT_REPO_PAT --repo org/repo
API_KEY=[secret-pane:PARENT_REPO_PAT:3f9a1c2e] npm test
```

That holds for a value the shell reads as plain text: letters, digits and `_ . : / + = @ , -`, starting with a letter, a digit or `_`, with no `:=`, as GitHub's tokens (`ghp_…`, `github_pat_…`) are. The value goes in as it is, wherever the placeholder stands: quoted or not, in a heredoc, after `=`, in a list (`&&`, `;`, `2>&1`).

A value holding any other character (a space, a quote, `$`, `!`, `%`) would change the command it lands in, so it goes in only as a whole single-quoted word, shell-quoted, in one command or a pipe of two; the answer to `request_secret` says which shape applies. A longer text is built with a pipe:

```
printf '%s' '[secret-pane:DB_PASSWORD:7c1e09ab]' | gh secret set DB_PASSWORD --repo org/repo
printf 'Authorization: Bearer %s' '[secret-pane:DB_PASSWORD:7c1e09ab]' | curl -fsS -H @- https://example.com/api
```

Whatever a command prints of a kept value comes back to Claude as its placeholder.

A command that names a placeholder is refused, its reason and its fix in one line, when:

- the session never minted the placeholder (an earlier session's, one from before a `/clear`), or, for an inert value, it stands right after `$` or `${` (the value would be a variable's name), `$name` (it would run into the name) or `$name:` (a zsh modifier); the fix says which, `${name}` before the placeholder for the last two. The strict shape refuses any `$` with its own fix;
- a git or gh word anywhere in it, `sh -c "..."` and a pipe's `stdbuf git commit` included, may write the value into history or send it out: git with a subcommand outside the local ones (`status`, `diff`, `log`, `fetch`, `clone`, `add`, `config`, `credential`, ...; the list is `GIT_LOCAL` in `hooks/shell.ts`), or any gh but `gh secret`. An alias counts as unknown, so `git ci` is refused as `git commit` is. The refusal of `git push` says how to hand git the token instead, then push with no placeholder; that of gh, how to store the value as a secret or call GitHub's API with curl;
- for a value of the strict shape, the placeholder is not a whole single-quoted word, or the command holds `;`, `&` but in a redirection (`2>&1`), `&&`, `||`, `$`, `(`, `)`, a backtick, `<`, a new line, a second pipe, a wrapper that runs its arguments as another command (`sh`, `bash`, `env`, `xargs`, `eval`, `sudo`, `ssh`...) or an assignment in front. A command naming a strict value holds every placeholder it names to that shape, an inert one included;
- it runs in the background: its output is written to disk and read back past the mod.

A Write, an Edit or a NotebookEdit whose text holds a placeholder of this session is refused too: the file would hold the placeholder where the value was meant. The refusal names the Bash command that writes the value, `printf 'NAME=%s\n' '<placeholder>' >> .env`, and says to write `NAME` to mention the secret without its value. Every fix a refusal names is a command that runs, whatever the value holds: `FIXES` in `hooks/shell.ts`, which `hooks/shell.spec.ts` runs through the mod. A placeholder the session never minted is written as text, an example as in this README.

If you would rather not wait for Claude to think of the tool, say `use secret-pane to ask me for PARENT_REPO_PAT`.

## How it works

- `session.start` registers the tool with `isDeferred: false`, so Claude sees it on every turn.
- The box is a pane opened with `$.ui.open` and drawn with an `Input`. The element has no password mode, so the mod masks it itself: the field draws one dot per character held, and each change hands back the dots kept plus what was typed or pasted. An edit in the middle of the field cannot be read that way, so it empties the field and the box says why. A hook's own time is capped, and time inside a host call is not counted, so the mod waits for you in short `sleep` processes (`Start-Sleep` through PowerShell on Windows), up to ten minutes; whatever ends the wait, the box closes and the slot frees.
- On a terminal narrower than 144 columns Claude Code does not place a pane nobody asked for, so the box draws in the band above the prompt instead: press ctrl+x then tab to type in it; Enter on an empty field cancels.
- A Bash command is read in this order before it runs. A placeholder the session never minted refuses it. Each git and gh word of the whole command is held to the local subcommands and `gh secret`. If every value it names is inert (`isInert` in `hooks/vault.ts`), a placeholder right after a `$` refuses it, and each placeholder is then replaced by its value, as it is; otherwise the command must take the strict shape, which a lexer reads (`restoreStrict` in `hooks/shell.ts`), each value shell-quoted. A refusal's fix names the command's placeholder when it names one, and the placeholder at fault in the strict shape. Then comes the check of the changes below, then the permission: a refused command asks nobody.
- The vault maps each value to a placeholder that stays stable within the session, in the module's memory only; `session.start` and `session.end` (a `/clear` too) empty it. Every kept value is hidden in one pass, placeholders matched first so a value found inside one never rewrites it.
- Two layers hide a value on the way back. A `tool.call` hook on Bash, Read, Write, Edit, NotebookEdit, Monitor, GetTask and LSP hides it in the tool's record, which the session file stores, the file a Write replaced included; a result holding none comes back as it came. A `session.append` hook hides it in every row the model reads, whatever door it came by: a tool's result, a task's notification, a hook's context, a prompt. A `prompt.submit` hook hides it in a prompt and its context before they are queued. Measured in a live `claude -p` session with a probe mod: a `session.append` rewrite of a Bash result and of a background task's output reached the model, and the session file kept the raw `toolUseResult`, which only `tool.call` changes.
- While a value is kept, a Bash command that may commit or publish is checked before it runs, placeholder or not: one that names a git subcommand outside the local ones, or a gh subcommand other than `gh secret`, anywhere in its text, `sh -c "git commit ..."` included (`gh stack add -Am` commits). The body of a heredoc whose delimiter is quoted, the commit message of `git commit -m "$(cat <<'EOF' ... EOF)"` among them, is text, not commands, unless a shell on its line runs it (`bash <<'EOF'`). The mod finds the repository the command acts on: the `cd` and `pushd` commands before it, composed, after a keyword or a brace too, a subshell's left in it; or else the session's directory, which follows Claude's `cd`; with the `-C`, `--git-dir` and `--work-tree` it hands git, or the `GIT_DIR=` and `GIT_WORK_TREE=` in front of it. There it runs `git diff --cached` and `git diff` and searches the lines they add, then reads every untracked file git does not ignore; it also reads the files the command is handed: each one gh's arguments name (`gh gist create .env`, `--body-file log`, `-F body=@notes.md`), the one git reads its message from (`git commit -F msg`), the one its standard input reads (`< .env`, a `cat .env` piped straight into it), and the one a substitution in an argument prints (`--body "$(cat body.md)"`). A file pattern (`gh release upload v1 dist/*`) is not expanded, so the files it names are not read. It searches each value's longest line, so a key spread over lines is found by a line of its body, not by its header. A hit refuses the command and names each file with its fix: `.gitignore` for an untracked one; the value out, or `git rm --cached`, for a tracked one; the file left out for one the command is handed. A check that cannot read every change refuses too, saying why: no repository for git (gh outside any repository carries no change), a directory the command makes itself (`mkdir x && cd x && git init && git commit`), git failing, an output over 4 MiB, more than 1000 untracked files, a `cd` to a place the mod cannot read (`cd $DIR`, `popd`). The values never leave the mod: git prints the changes, and the mod searches them.
- The permission is decided on the command as it runs, value in. On a real call the mod restored, a `tool.check` hook on Bash reads the session's verdict first; where it would ask, the mod asks through `$.ui.ask` instead, the command as Claude wrote it on show, with Run it and Don't run it alone. A query of a permission is left alone.
- The hooks that guard fail closed: a check that breaks withholds the result or refuses the call, and a row whose check breaks reaches the model with its text withheld.

## Limits

- It hides what Claude reads, not what Claude does. With the placeholder, Claude can still run a command that transforms the value (`base64`, `rev`) or sends it wherever curl or ssh reach, GitHub's API included (`curl -d`), and the transformed output is not recognized. This keeps a value out of the transcript by accident; it is no sandbox against a model trying to leak one.
- The answer to `request_secret` says which shape a value takes, so it tells Claude one bit of the value: whether it holds a character the shell reads.
- An inert value goes in as it is, so a shell construct around its placeholder still acts on it: `{a,<placeholder>}` brace-expands a value holding `,`, `${x//<placeholder>/y}` splits on its `/`, `$(( <placeholder> ))` reads it as arithmetic. And a placeholder in prose becomes the value: a heredoc that writes a pull request's body with it writes the value. The check before a commit or a publish reads that body when the command is handed it (`--body-file`, `-F`, `--body "$(cat body.md)"`); `docker build --build-arg TOKEN=<placeholder>` keeps the value in an image a later `docker push` publishes, which no check reads.
- The inert shape is checked in bash: `hooks/shell.spec.ts` runs a value of every inert character through bash unquoted, in `'...'`, `"..."` and `$'...'`, in both heredocs, in `sh -c "..."`, an assignment and a substitution, and reads it back unchanged. zsh is not measured; a placeholder after `$name:` is refused all the same, since zsh would read the value as a modifier.
- The command with the real value in it is what runs: a settings `PreToolUse` or `PostToolUse` hook receives it (measured in the kit: the `classic.PreToolUse` hook beneath the mod sees the restored command). The permission dialog does not, nor an "always allow" rule in `settings.local.json`: the mod asks instead. In auto mode too, on purpose: the classifier would read the value; you are asked instead. A settings rule or the mode that allows or denies the command outright is left to decide. Not measured in a live session: that the mod's question draws while the check waits; the kit raises no permission check on a real call.
- Only Bash gets the real value. Write, Edit and NotebookEdit refuse a placeholder of this session; a step that needs the value in a file is a Bash command that writes it (`printf 'NAME=%s\n' '<placeholder>' >> .env`), and the file then holds the value in clear.
- Tools outside the `tool.call` list of How it works keep a raw value in the record the session file stores, though the model reads it hidden. On Windows that includes Grep, which this build has only there.
- The check before a commit or a publish reads the changes as they stand before the command, never the history: a value committed by a way the mod does not see (a script, a subagent's worktree, a script a heredoc writes and the same command runs) is pushed with the rest, and so is a file the command itself brings in, `git add -f` of an ignored one or `cp .env.local config.env && git add -A && git commit`. It does not read a change to a tracked binary file, an untracked file over 4 MiB or a submodule either, nor a command run over ssh, which runs on another machine. It follows the session's `cd`, not a subagent's: a subagent's commit is checked where the session stands, unless its command `cd`s first. And since it reads the working tree, it refuses a push too while a value stands in a file not committed yet.
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

`hooks/register.test.ts` is the kit's suite: the box on the pane and in the band and what it refuses to keep, the placeholder in and out of Bash, the hiding in a later command's output, in a file read, in a Write's record and in a row any door appends, the refusals of commands and of file writes, `/clear`, the prompt and its context, what the settings hooks see. `hooks/shell.spec.ts` is the restoring of a placeholder in each shape, an inert value read back through bash, and the reading of git and gh in a command, `hooks/scan.spec.ts` the check of the changes, on a fake host and on a real repository, `hooks/vault.spec.ts` the vault and the field.
