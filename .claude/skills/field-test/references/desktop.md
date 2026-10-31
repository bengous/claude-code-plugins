# Driving Claude Desktop: what was measured

What `scripts/field-test-desktop.ts` relies on, and how a field test sees a mod in the Code tab of Claude Desktop without the person. Measured on Linux with Hyprland, while field-testing the `cloud-pull` mod; "not measured" marks the rest.

## Which session draws a mod

- A new session (the sidebar's **+**, `claude://code/new`) starts no Claude Code process until its first message: no mod code runs and nothing a mod draws can show (measured: no new process for 25 s, Desktop's log at `sessionId=null`).
- A settings `SessionStart` hook fires at that first message too, never on the empty new-session screen (measured with a probe hook writing a line per run).
- An existing session starts its process as soon as it is shown, with no message: Desktop's log reads `Warming session`, `session spawn`, `warmed successfully`, and the mod's `session.start` runs, so its band draws (measured). That is the way to see a mod before any prompt: make a session first, then show it.
- Make a session with no model turn from the CLI: `claude -p "/rename <title>" --output-format json` in the folder (0 turns, $0; the transcript keeps the two `/rename` rows), then `open <its uuid>` to import and show it.
- Desktop reads an installed plugin from its marketplace folder at each session start; a running session keeps the version it started with (there is no plugin reload in Desktop). A test after an edit needs a new session.
- To test an unmerged plugin in Desktop, install it from a marketplace whose `marketplace.json` sits in the plugin's own folder (`"source": "./"`), kept out of git with `.git/info/exclude`. A marketplace folder holding a symlink to the plugin is refused: "Path escapes plugin directory" (measured).
- The `/` menu of a session with no process comes from a temporary query Desktop runs with `disableAllHooks`: commands a mod registers in `session.start` are missing there and typing one shows "isn't a command here", though it runs (anthropics/claude-code#99691; measured 181 commands with the setting, 185 without).
- `claude --desktop` and `/desktop` refuse Linux ("isn't available on this platform").

## Showing, capturing, clicking

- `open <uuid>` imports a CLI session (`claude://resume?session=`, undocumented: it reads `session` alone) and focuses it; `open local_<id>` shows a Desktop session; `new --folder <dir> --prompt <text>` opens the documented new-session page with its prompt box filled.
- A session started from this session with `start_session` can be popped out into its own window with `open_session_in` (`window`); its window's title is the session's title, which `--window` matches.
- `windows` lists Desktop's windows and their workspace. A capture or a click acts on a window's geometry: when the person's screen shows another workspace, a click lands in whatever is there (measured: a click landed in a browser). `click` and `key` focus the window first, which brings its workspace forward; they move the person's pointer and type into the focused field, so they run only with the person's go-ahead.
- `shot --half` saves a half-size image, cheaper to read; click coordinates are full size, so double what the half image shows.
- `key Enter` reaches the prompt only once the prompt holds the focus: click into it first (measured: an Enter sent after `new` alone did nothing).
- A pane opens in the right column, the band sits just above the prompt, a toast shows at the bottom right of Desktop's main window even for a popped-out session (measured).

## Reading

- Desktop's log, `~/.config/Claude/logs/main.log`: `Resume deep link: importing CLI session`, `Warming session`, `session spawn`, `setFocusedSession`, `temporary query`. `mark` before a gesture, then `log --since <mark>`.
- `process <uuid>` says whether a Claude Code process resumes that session (Desktop spawns it with `--resume=<uuid>`). Desktop caps live processes (`CliGovernor`, cap 10 here) and evicts the most idle.
- The transcript of a Desktop session is `~/.claude/projects/<cwd slug>/<cli uuid>.jsonl`, the same file `field-test.ts messages` reads. Rows of type `system` are notices the model never reads; `attachment` rows include every settings `SessionStart` hook's output.
- What Claude receives from a Desktop session: a `/command` leaves its rows (`<command-name>`, its output) in the context of later turns; a prompt a `prompt.submit` hook answers with `{ drop }` leaves only a `system` notice, and Desktop draws its own "A hook blocked your prompt" card, which no mod can hide.
- `send_message` from another session delivers text, never a command: a `/name` sent that way reaches the model as a prompt.

## Cost

- Test sessions on Haiku, low effort, one-line prompts. A zero-turn path (`-p` with a slash command as the whole prompt) costs nothing; a `claude -p` without `--model` runs the account's default model.
