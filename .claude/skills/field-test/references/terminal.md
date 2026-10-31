# Driving a session: what was measured

What `scripts/field-test.ts` relies on, and what a field test can and cannot see. Each fact names where it was measured; "not measured" marks the rest.

## Launch

- `start` runs the `claude` binary in a detached tmux session named `field-test-<name>`, in `/tmp/field-test-<name>/work`, with `--permission-mode default` (the status line reads `manual mode on`), `--model`, `--session-id` and `--debug-file`, plus one `--plugin-dir` per plugin. It runs the binary, not the owner's shell function, which injects `--dangerously-skip-permissions`.
- `--ref` adds a detached worktree at `/tmp/field-test-<name>/source` and reads the plugins there; `stop` removes it.
- At 220 × 50 the griller pane docks beside the chat (measured, griller). A narrower terminal may place a pane in the band above the prompt instead: pass `--width` to field-test that layout; the column where it switches is not measured.
- No trust dialog showed for `/tmp/field-test-*` (measured, this machine). If one shows, `start` prints the screen and exits 3 with the session running: read the choices, answer with `keys`.
- `start` returns once the prompt `❯` shows; the plugin's `session.start` hook may still be running then.

## Keys and focus

- The terminal draws the focused control in reverse video (SGR 7). A text field holding the focus shows no reverse mark: `focused` then answers that no control has it.
- A pane opened with `focus: true` takes the keys, its autofocused field first (measured, griller). Tab walks its controls in order and wraps: after the last one comes the pane's close mark `✕`, then the first control again. Enter on `✕` closes the pane, which in griller drops the round unsent. `press` presses Enter only once the named control holds the focus.
- A band takes the keys after `C-x` then `Tab`; `Escape` returns to the prompt (measured in the `mod-forge` skill's live check).
- `send` types into whatever holds the focus (the pane's field, or the prompt) and presses Enter. A slash command with arguments runs as typed; one that calls no model costs no turn.
- A permission prompt reads `Do you want to`: `wait` for it, then answer with `keys`.
- A toast lasts about four seconds: `wait` for its text right after the gesture (measured in the `mod-forge` skill's live check).

## Reading

- `screen --pane` keeps the side right of the divider most rows share, on display columns, so a two-cell character in the chat (❓) does not shift it. With no pane docked it fails: read `screen` whole.
- `messages` reads the transcript at `~/.claude/projects/<cwd slug>/<session id>.jsonl` (under `CLAUDE_CONFIG_DIR` when set). It keeps prompts, replies and tool calls by name; it leaves out meta rows (a skill's text), thinking, tool results and the `api-request-blob` rows, which repeat the prompt and the system context and make a plain `grep` of the file match the prompt itself.
- The chat can hide what the transcript keeps: griller's ➡️ recommendations are masked on screen and present in `messages --last` (measured, griller).
- Hook errors land in the debug log `start` prints.

## Desktop and mobile

This drive covers the terminal. The kit pins the desktop tree (`$.ui.mount({ surface: "desktop" })`). Desktop's paint is driven by `scripts/field-test-desktop.ts` on Linux with Hyprland: [desktop.md](desktop.md). `claude --desktop` refuses Linux. Mobile is not driven. Say in the report which surfaces the run did not see.

## Agents and cost

- In an agent worktree a Bash call runs one simple command, and a bare `sleep` is refused: every step here is one `field-test.ts` call, `wait` included.
- Each model turn spends the user's quota. One-line prompts, two sessions per field test (base and change), `stop` as soon as the report holds the evidence.
- `stop` runs `claude purge --yes` on the work directory `start` made, which deletes that project's transcripts (measured). A `--cwd` directory's Claude Code data is left alone.
