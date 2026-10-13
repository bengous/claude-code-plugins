# secret-pane

A Claude Code mod that lets Claude use a secret it never sees. When a task needs an API key, a token or a password, Claude calls `request_secret`, a masked box opens beside the transcript, you paste the value, and Claude gets a placeholder such as `[secret-pane:PARENT_REPO_PAT:3f9a1c2e]`. The placeholder becomes the real value inside a Bash command and is hidden again in the command's output. The value lives in the session's memory alone: nothing is written to disk, and nothing reaches the transcript.

A value that reaches the conversation is in the transcript for good: sent to the model on every turn after, kept in the session file, replayed into every fork. The one fix is never to send it. secret-pane closes the two ways in, a paste and a command that prints the value, and still lets Claude run the command that needs it.

## Install

```
/plugin install secret-pane --marketplace bengous/claude-code-plugins
```

## Use

Ask for something that needs a secret: `set the PARENT_REPO_PAT secret on the three repositories`. Claude calls `secret-pane - request_secret` with the variable's name and a one-line reason.

- **Paste** the value into the box. It draws dots and a character count, never the text.
- **Enter** keeps it. A toast says so, and Claude gets the placeholder.
- **Esc** cancels. Claude is told, and nothing is kept.

Claude then writes the placeholder where the value goes:

```
printf '%s' '[secret-pane:PARENT_REPO_PAT:3f9a1c2e]' | gh secret set PARENT_REPO_PAT --repo org/repo
gh api -H 'Authorization: Bearer [secret-pane:PARENT_REPO_PAT:3f9a1c2e]' repos/org/repo
```

The first runs with the real value, and whatever the command prints of it comes back to Claude as the placeholder; the tool row says `secret-pane: 1 value(s) put in and hidden again`. The second runs as written: a command that posts to GitHub or writes git history (`gh api`, `gh issue`, `gh pr`, `git commit`, `git tag`) gets no real value, since text that leaves the machine cannot be taken back. Verify a token with the command that needs it, not with `gh api`.

If you would rather not wait for Claude to think of the tool, say `use secret-pane to ask me for PARENT_REPO_PAT`.

## How it works

- `session.start` registers the tool with `isDeferred: false`, so Claude sees it on every turn.
- The box is a pane opened with `$.ui.open` and drawn with an `Input`. The element has no password mode, so the mod masks it itself: the field draws one dot per character held, and each change hands back the dots kept plus what was typed or pasted. A hook's own time is capped, and time inside a host call is not counted, so the mod waits for you in short `sleep` processes, up to ten minutes.
- On a terminal narrower than 144 columns Claude Code does not place a pane nobody asked for, so the box draws in the band above the prompt instead: press ctrl+x then tab to type in it; Enter on an empty field cancels.
- The vault maps each value to a placeholder that stays stable within the session, in the module's memory only. A `tool.call` hook on `Bash` restores placeholders in the command and swaps the values it handed back for their placeholders in the result, the error text and the context; a `prompt.submit` hook swaps a kept value you paste into the prompt.
- A value holding characters the shell would read as code (a space, a quote, `$`, `;`, `|`) is never put into Bash: the call is refused and Claude is told to write the value to a file with the Write tool instead.
- The hooks that guard fail closed: a check that breaks withholds the result or refuses the call.

## Limits

- It hides what Claude reads, not what Claude does. With the placeholder, Claude can still run a command that transforms the value (`base64`, `rev`) or sends it somewhere, and the transformed output is not recognized. This keeps a value out of the transcript by accident; it is no sandbox against a model trying to leak one.
- Only Bash gets the real value. A placeholder in a file Claude writes stays a placeholder. A step that needs the value in a file is a Bash command that writes it.
- The vault is memory only: a hot reload of the mod or a new session forgets every value, and a placeholder from an earlier session means nothing. Claude asks again.
- One secret at a time: a second `request_secret` while the box is open is answered with a refusal, not a second box.
- `claude -p` has no one to type, so the tool answers that it needs an interactive session.
- The masking is the mod's own. A paste can show for one frame before it is redrawn as dots, and an edit in the middle of the field with the arrow keys is not tracked: clear the field and paste again.
- A value under four characters is left as printed wherever it turns up.

## Develop

```
claude --plugin-dir ./secret-pane
claude plugin validate secret-pane
claude plugin test secret-pane
bun test secret-pane
```

`hooks/register.test.ts` is the kit's suite: the box on the pane and in the band, the placeholder in and out of Bash, the publishing commands, the shell-active refusal, the prompt swap. `hooks/vault.spec.ts` is the vault alone.
