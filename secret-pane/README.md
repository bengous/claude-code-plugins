# secret-pane

A Claude Code mod that lets Claude use a secret it never sees. When a task needs an API key, a token or a password, Claude calls `request_secret`, a masked box opens beside the transcript, you paste the value, and Claude gets a placeholder such as `[secret-pane:PARENT_REPO_PAT:3f9a1c2e]`. The placeholder becomes the real value inside a Bash command, and the value is hidden again in every Bash and Read result and in the prompt. The value lives in the session's memory alone: the mod writes nothing to disk, and nothing of it reaches the transcript.

A value that reaches the conversation is in the transcript for good: sent to the model on every turn after, kept in the session file, replayed into every fork. The one fix is never to send it. secret-pane closes the ways in, a paste and a tool result that prints the value, and still lets Claude run the command that needs it.

## Install

```
/plugin marketplace add bengous/claude-code-plugins
/plugin install secret-pane@bengous-plugins
```

## Use

Ask for something that needs a secret: `set the PARENT_REPO_PAT secret on the three repositories`. Claude calls `secret-pane - request_secret` with the variable's name and a one-line reason.

- **Paste** the value into the box. It draws dots and a character count, never the text.
- **Enter** keeps it. A toast says so, and Claude gets the placeholder.
- **Esc** cancels. Claude is told, and nothing is kept.

Claude then writes the placeholder where the value goes:

```
printf '%s' '[secret-pane:PARENT_REPO_PAT:3f9a1c2e]' | gh secret set PARENT_REPO_PAT --repo org/repo
curl -fsS -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer [secret-pane:PARENT_REPO_PAT:3f9a1c2e]' https://api.github.com/repos/org/repo
```

Each runs with the real value, and whatever a command prints of it comes back to Claude as the placeholder; the tool row says `secret-pane: 1 value(s) put in and hidden again`. A command that holds a placeholder is refused when it would write git history or send text to GitHub (`git commit`, `git tag`, `git merge`, `gh api`, `gh issue`, `gh pr`; `gh secret` alone takes the value), since text that leaves the machine cannot be taken back, and when it runs in the background, since its output never comes back through the mod. Claude is told to run the command that needs the value alone, in the foreground.

If you would rather not wait for Claude to think of the tool, say `use secret-pane to ask me for PARENT_REPO_PAT`.

## How it works

- `session.start` registers the tool with `isDeferred: false`, so Claude sees it on every turn.
- The box is a pane opened with `$.ui.open` and drawn with an `Input`. The element has no password mode, so the mod masks it itself: the field draws one dot per character held, and each change hands back the dots kept plus what was typed or pasted. A hook's own time is capped, and time inside a host call is not counted, so the mod waits for you in short `sleep` processes (`Start-Sleep` through PowerShell on Windows), up to ten minutes; whatever ends the wait, the box closes and the slot frees.
- On a terminal narrower than 144 columns Claude Code does not place a pane nobody asked for, so the box draws in the band above the prompt instead: press ctrl+x then tab to type in it; Enter on an empty field cancels.
- The vault maps each value to a placeholder that stays stable within the session, in the module's memory only. One `tool.call` hook on `Bash` and `Read` restores placeholders in a Bash command and swaps every kept value for its placeholder in the result, the error text and the context of both tools; a `prompt.submit` hook swaps a kept value you paste into the prompt.
- A value holding characters the shell would read as code (a space, a quote, `$`, `;`, `|`) is never put into Bash: the call is refused, and Claude is told to ask you to enter the value where it is needed yourself, since no tool of the session can carry it.
- The hooks that guard fail closed: a check that breaks withholds the result or refuses the call.

## Limits

- It hides what Claude reads, not what Claude does. With the placeholder, Claude can still run a command that transforms the value (`base64`, `rev`) or sends it somewhere other than git and GitHub, and the transformed output is not recognized. This keeps a value out of the transcript by accident; it is no sandbox against a model trying to leak one.
- The command with the real value in it is what runs: the permission dialog shows it, a settings `PreToolUse` or `PostToolUse` hook receives it, and in auto mode the classifier reads it. Answer the dialog with a plain yes: a "don't ask again" rule would keep the command, value included, in `settings.local.json`. (Measured in the kit: the `classic.PreToolUse` hook beneath the mod sees the restored command.)
- Only Bash gets the real value. A placeholder in a file Claude writes with Write or Edit stays a placeholder; a step that needs the value in a file is a Bash command that writes it, and the file then holds the value in clear.
- The results of Bash and Read are the ones scanned. Grep is not in this build's tool table on macOS and Linux (Claude searches with `grep` through Bash, which is scanned); on Windows, a Grep result that holds the value is not hidden.
- The vault is memory only: a hot reload of the mod or a new session forgets every value, and a placeholder from an earlier session means nothing. Claude asks again.
- One secret at a time: a second `request_secret` while the box is open is answered with a refusal, not a second box.
- `claude -p` has no one to type, and a session drawn on a phone alone has no box: the tool answers that it needs a terminal or a desktop.
- The masking is the mod's own. A paste can show for one frame before it is redrawn as dots, and an edit in the middle of the field with the arrow keys is not tracked: clear the field and paste again.
- A value under four characters is left as printed wherever it turns up; its refusal names it by its placeholder.
- The wait on Windows (`powershell -NoProfile -Command Start-Sleep`) is not measured.

## Develop

```
claude --plugin-dir ./secret-pane
claude plugin validate secret-pane
claude plugin test secret-pane
bun test secret-pane
```

`hooks/register.test.ts` is the kit's suite: the box on the pane and in the band, the placeholder in and out of Bash, the hiding in a later command's output and in a file read, the refusals (publishing, background, shell-active, short values), the prompt swap, what the settings hooks see. `hooks/vault.spec.ts` is the vault alone.
