# todos

A Claude Code mod that lists the repository's TODOs in a band above the prompt, newest first, so the open work is in front of you when a session starts.

```text
╭────────────────────────────────────────────────────────────────────────────────────────────────[-]
│ todos · 12                                                                                      │
│ ○ src/new.ts:2 cache the answer                                                        #9 today │
│ ● TODO.md      Write the README before the release                                        11d   │
│ ○ TODO.md      Add a CI job for the plugin tests                                          11d   │
│ ● deploy.sh:3  move secrets to the vault                                               #7 11d   │
│ ○ src/old.ts:2 FIXME handles CRLF badly                                                   1y    │
│ 1–5 of 12 · 2 selected [ Show Claude ] [ Clear ] [ Mine ] [ Hide ]                              │
╰─────────────────────────────────────────────────────────────────────────────────────────────────╯
```

## Install

```bash
/plugin marketplace add bengous/claude-code-plugins
/plugin install todos@bengous-plugins
```

A mod runs inside Claude Code with your permissions; read [`hooks/register.ts`](hooks/register.ts) before you install it. Mods need a Claude Code version that ships them, and they draw only in the terminal and in the Code tab of the Desktop app: see [Where mods run](https://code.claude.com/docs/en/plugins/mods/overview#where-mods-run).

## What counts as a TODO

- **`TODO.md`** at the repository root: each top-level `- ` or `* ` item, and each unchecked `- [ ]` box. A checked box is done and left out. A title stops at its first `:` or `;` past ten characters.
- **Code comments** whose first word is a marker (`TODO`, `FIXME` and `HACK` by default): after `//`, `/*`, `#`, `--`, `<!--` or `;`, or after the `*` that continues a block comment. `const TODO_LIST`, a `TODO` inside a sentence, or a comment opened inside a string, such as a test's `"// TODO: x"`, is not one.

The comment search is `git grep` over tracked and untracked files, `.gitignore` respected. It skips prose, data and diff files (`.md`, `.txt`, `.json`, `.jsonl`, `.csv`, `.lock`, `.svg`, `.log`, `.patch` and a few more), where a marker is text about TODOs or a transcript quoting one.

It also skips the paths your `.gitattributes` marks `-todos`, and those it marks `linguist-vendored` or `linguist-generated`. `TODO.md` is read whatever its attributes.

```gitattributes
archive/** -todos
```

## Order and age

Each TODO is dated with `git blame`: the time its line was authored. The newest comes first. A line not committed yet, or in an untracked file, dates to the scan and reads `today`.

## The band

- It opens when an interactive session starts in a git repository that has TODOs. The scan runs after the session starts, so it never holds your first prompt.
- It hides on your next message, or on **Hide**. `/todos` scans again and reopens it.
- It lists `rows` TODOs at a time under a header and a footer that stay put. PgUp and PgDn scroll the list once the band is focused (ctrl+x tab or a click), and so does the wheel where Claude Code reads the mouse. The footer says which rows show, `1–5 of 12`.
- The `○` before a TODO picks it: click it, or Tab to it and press Enter. **Show Claude** puts the picked TODOs in the prompt box at the cursor, under `Read these TODOs:`, one `- path:line: text` per TODO, and gives the keys back to the prompt, where you write what Claude should do with them before you send. **Clear** drops the picks.
- **Mine** keeps the TODOs whose git author is your `user.email`, uncommitted lines included. **All** shows every one again.
- `TODO(#42)` links to issue 42 when `origin` is on GitHub.
- It keeps what other mods draw in the band below its own list.

When Claude edits a file with `Edit` or `Write` and adds a TODO, a toast names it: `New FIXME at deploy.sh:4: rotate the deploy key`. A file the scan skips raises none.

## Limits

- A string is recognized within one line only: a `# TODO` inside a multi-line string, such as a Python `"""` block, is listed.
- Every `git blame` runs once per file that holds a TODO, as many at a time as the machine has CPUs, sixteen at most (six on Windows, where `getconf` is missing), so the band of a repository with about a hundred such files opens after close to a second on a 16-CPU machine. Each edit that adds a TODO scans again.
- A title or comment longer than 200 characters is cut, and control characters are dropped.
- The list scrolls through the 500 newest TODOs, and as many of yours; the footer counts the others as `+N more`.
- A pick names a TODO by its line: a scan that moves the line, after an edit or `/todos`, drops the pick.

## Settings

Claude Code asks for them when you enable the plugin; they are also rows in `/config`.

| Setting | Default | What it does |
|---|---|---|
| `show_on_start` | `true` | Open the band when a session starts. `/todos` opens it either way. |
| `rows` | `8` | How many TODOs the band shows at once, the rest a scroll away; it shows fewer in a short terminal. |
| `markers` | `TODO,FIXME,HACK` | The comment words that mark a TODO, separated by commas. |
| `mine_only` | `false` | Start each session with **Mine** on. |

## Files

| Path | What it holds |
|---|---|
| `hooks/register.ts` | The hooks: session start, prompt, `/todos`, the edit toast, the band |
| `hooks/scan.ts` | The scan: `git grep`, `TODO.md`, `git blame`, through a host the hooks build from `$` |
| `hooks/parse.ts` | Pure parsing and formatting, covered by `bun test` |
| `hooks/register.test.ts` | Tests for `claude plugin test`, run in Claude Code's own test kit |
