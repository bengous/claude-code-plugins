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
- one of its commands is a wrapper that runs its arguments as another command (`sh`, `bash`, `env`, `xargs`, `eval`, `sudo`, `ssh`...), a git command that writes history or sends it out (`commit`, `tag`, `merge`, `push`, ...), or a gh command other than `gh secret`: text that leaves the machine cannot be taken back;
- it runs in the background: its output is written to disk and read back past the mod.

If you would rather not wait for Claude to think of the tool, say `use secret-pane to ask me for PARENT_REPO_PAT`.

## How it works

- `session.start` registers the tool with `isDeferred: false`, so Claude sees it on every turn.
- The box is a pane opened with `$.ui.open` and drawn with an `Input`. The element has no password mode, so the mod masks it itself: the field draws one dot per character held, and each change hands back the dots kept plus what was typed or pasted. An edit in the middle of the field cannot be read that way, so it empties the field and the box says why. A hook's own time is capped, and time inside a host call is not counted, so the mod waits for you in short `sleep` processes (`Start-Sleep` through PowerShell on Windows), up to ten minutes; whatever ends the wait, the box closes and the slot frees.
- On a terminal narrower than 144 columns Claude Code does not place a pane nobody asked for, so the box draws in the band above the prompt instead: press ctrl+x then tab to type in it; Enter on an empty field cancels.
- The vault maps each value to a placeholder that stays stable within the session, in the module's memory only; `session.start` and `session.end` (a `/clear` too) empty it. Every kept value is hidden in one pass, placeholders matched first so a value found inside one never rewrites it.
- Two layers hide a value on the way back. A `tool.call` hook on Bash, Read, Edit, NotebookEdit, Monitor, GetTask and LSP hides it in the tool's record, which the session file stores; a result holding none comes back as it came. A `session.append` hook hides it in every row the model reads, whatever door it came by: a tool's result, a task's notification, a hook's context, a prompt. A `prompt.submit` hook hides it in a prompt and its context before they are queued. Measured in a live `claude -p` session with a probe mod: a `session.append` rewrite of a Bash result and of a background task's output reached the model, and the session file kept the raw `toolUseResult`, which only `tool.call` changes.
- The permission is decided on the command as it runs, value in. On a real call the mod restored, a `tool.check` hook on Bash reads the session's verdict first; where it would ask, the mod asks through `$.ui.ask` instead, the command as Claude wrote it on show, with Run it and Don't run it alone. A query of a permission is left alone.
- The hooks that guard fail closed: a check that breaks withholds the result or refuses the call, and a row whose check breaks reaches the model with its text withheld.

## Limits

- It hides what Claude reads, not what Claude does. With the placeholder, Claude can still run a command that transforms the value (`base64`, `rev`) or sends it to a host other than git and GitHub, and the transformed output is not recognized. This keeps a value out of the transcript by accident; it is no sandbox against a model trying to leak one.
- The command with the real value in it is what runs: a settings `PreToolUse` or `PostToolUse` hook receives it (measured in the kit: the `classic.PreToolUse` hook beneath the mod sees the restored command). The permission dialog does not, nor an "always allow" rule in `settings.local.json`: the mod asks instead. In auto mode too, on purpose: the classifier would read the value; you are asked instead. A settings rule or the mode that allows or denies the command outright is left to decide. Not measured in a live session: that the mod's question draws while the check waits; the kit raises no permission check on a real call.
- Only Bash gets the real value. A placeholder in a file Claude writes with Write or Edit stays a placeholder; a step that needs the value in a file is a Bash command that writes it (`printf '%s' '<placeholder>' > file`), and the file then holds the value in clear.
- Tools outside the `tool.call` list keep a raw value in the record the session file stores, though the model reads it hidden. On Windows that includes Grep, which this build has only there.
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

`hooks/register.test.ts` is the kit's suite: the box on the pane and in the band and what it refuses to keep, the placeholder in and out of Bash, the hiding in a later command's output, in a file read and in a row any door appends, the refusals, `/clear`, the prompt and its context, what the settings hooks see. `hooks/shell.spec.ts` is the command allow-list, `hooks/vault.spec.ts` the vault and the field.
