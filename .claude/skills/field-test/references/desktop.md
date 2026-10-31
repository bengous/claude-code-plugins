# Driving Claude Desktop: what was measured

What `scripts/field-test-desktop.ts` relies on, and how a field test sees a mod in the Code tab of Claude Desktop without the person. Measured on Linux with Hyprland, while field-testing the `cloud-pull` mod; "not measured" marks the rest.

## Which session draws a mod

- A new session (the sidebar's **+**, `claude://code/new`) starts no Claude Code process until its first message: no mod code runs and nothing a mod draws can show (measured: no new process for 25 s, Desktop's log at `sessionId=null`).
- A settings `SessionStart` hook fires at that first message too, never on the empty new-session screen (measured with a probe hook writing a line per run).
- An existing session starts its process as soon as it is shown, with no message: Desktop's log reads `Warming session`, `session spawn`, `warmed successfully`, and the mod's `session.start` runs, so its band draws (measured). That is the way to see a mod before any prompt: make a session first, then show it.
- Make a session with no model turn from the CLI: `claude -p "/rename <title>" --output-format json` in the folder (0 turns, $0; the transcript keeps the two `/rename` rows), then `open <its uuid>` to import and show it.
- Desktop reads an installed plugin from its marketplace folder at each session start; a running session keeps the version it started with (there is no plugin reload in Desktop). To load an edit into a session already open, end its Claude Code process (`process <uuid>` gives the pid), show another session, then show the first again: Desktop warms it with the new code ("Warming session", "warmed successfully"). Showing the tab already on screen again starts nothing (the log shows the exit, then nothing). A `pkill -f`/`pgrep -f` on `resume=<uuid>` also matches the shell that runs it, whose command line holds the pattern: kill by the pid `process` prints.
- To test an unmerged plugin in Desktop, install it from a marketplace whose `marketplace.json` sits in the plugin's own folder (`"source": "./"`), kept out of git with `.git/info/exclude`. A marketplace folder holding a symlink to the plugin is refused: "Path escapes plugin directory" (measured). See "Install and clean up" below.
- The `/` menu of a session with no process comes from a temporary query Desktop runs with `disableAllHooks`: commands a mod registers in `session.start` are missing there and typing one shows "isn't a command here", though it runs (anthropics/claude-code#99691; measured 181 commands with the setting, 185 without).
- `claude --desktop` and `/desktop` refuse Linux ("isn't available on this platform").

## Install and clean up

Installing writes the person's own Claude Code settings, which a dotfiles manager may own, and every opened session stays in their sidebar. Name both to the person before the run, and undo them after it.

1. Write the dev marketplace in the plugin folder: `.claude-plugin/marketplace.json` with a name of its own (for example `<plugin>-dev`) and one entry, `"source": "./"`. Add its path to `.git/info/exclude`.
2. `claude plugin marketplace add <plugin folder>`, then `claude plugin install <plugin>@<plugin>-dev --scope user`. Both edit `~/.claude/settings.json` (`extraKnownMarketplaces`, `enabledPlugins`).
3. After the run: `claude plugin uninstall <plugin>@<plugin>-dev --scope user`, `claude plugin marketplace remove <plugin>-dev`, delete the dev `marketplace.json` and its exclude line. Removing this dev marketplace is safe; never remove the repository's own marketplace (catalog.md).
4. List the sessions and worktrees the run made (Desktop sessions it opened, worktrees a plugin created, sessions imported with `open`) and archive or delete them only on the person's word: archiving and deleting are theirs to approve.

## Showing, capturing, clicking

- `open <uuid>` imports a CLI session (`claude://resume?session=`, undocumented: it reads `session` alone) and focuses it; `open local_<id>` shows a Desktop session. Both wait for Desktop's log to name the session and fail when it does not within 10 s. `new --folder <dir> --prompt <text>` opens the documented new-session page with its prompt box filled; no log line confirms it, so check with `shot`.
- A session started from this session with `start_session` can be popped out into its own window with `open_session_in` (`window`); its window's title is the session's title, which `--window` matches.
- `windows` lists Desktop's windows and their workspace. A capture or a click acts on a window's geometry: when the person's screen shows another workspace, it hits whatever is there (measured: a click landed in a browser). `shot` refuses a window whose workspace is not on screen unless `--focus` brings it forward. `click` and `key` focus the window first; they move the person's pointer and type into the focused field, so they run only with the person's go-ahead.
- `click` first moves the pointer to a calibration point to learn how ydotool's absolute range maps onto the screen on each axis (it was 2 on both here), then moves to the target and clicks only when the pointer sits within 2 pixels of it on both axes.
- `shot` writes into a new temporary directory and prints the path, unless `--out` names a file; `--half` saves a half-size image, cheaper to read, and click coordinates stay full size, so double what the half image shows.
- `key Enter` reaches the prompt only once the prompt holds the focus: click into it first (measured: an Enter sent after `new` alone did nothing).
- A pane opens in the right column, the band sits just above the prompt, a toast shows at the bottom right of Desktop's main window even for a popped-out session (measured).
- A pane a mod opens in `session.start`, unasked, can be placed after `$.ui.open` answered: in a session imported with `claude://resume`, `$.ui.open` answered `isPlaced: false` and Desktop drew the pane a moment later. A value the mod keeps from that answer stays wrong; read `$.ui.panes()` while drawing instead. A `ui.render` hook cannot write state: the host refuses `state.set` during a render.
- A `Button` with `role: "dismiss"` in the band does not become Desktop's native ✕: with `plain` it draws as its label's text, without it as an ordinary button.

## Reading

- Desktop's log, `~/.config/Claude/logs/main.log`: `Resume deep link: importing CLI session`, `Warming session`, `session spawn`, `setFocusedSession`, `temporary query`. `mark` before a gesture prints a byte offset; `log --since <mark>` prints what was written after it. Desktop rotates the log to `main1.log`; `log` then reads the rest of the old one first, and fails when the mark is older than both.
- `process <uuid>` says whether a Claude Code process resumes that session (Desktop spawns it with `--resume=<uuid>`). Desktop caps live processes (`CliGovernor`, cap 10 here) and evicts the most idle.
- The transcript of a Desktop session is `~/.claude/projects/<cwd slug>/<cli uuid>.jsonl`, the same file `field-test.ts messages` reads. Rows of type `system` are notices the model never reads; `attachment` rows include every settings `SessionStart` hook's output.
- What Claude receives from a Desktop session: a `/command` leaves its rows (`<command-name>`, its output) in the context of later turns; a prompt a `prompt.submit` hook answers with `{ drop }` leaves only a `system` notice, and Desktop draws its own "A hook blocked your prompt" card, which no mod can hide.
- `send_message` from another session delivers text, never a command: a `/name` sent that way reaches the model as a prompt.

## Cost

- Test sessions on Haiku, low effort, one-line prompts. A zero-turn path (`-p` with a slash command as the whole prompt) costs nothing; a `claude -p` without `--model` runs the account's default model.
