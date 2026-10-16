# pinpoint

Point at your running app and talk to Claude. In your app's dev build, an overlay lets you pick an element by a click or a zone by a drag, give it a quick label or a note, and keep it in a batch. You send the batch when you are done, and it reaches the Claude Code session as one prompt, each element described precisely enough to find it in the code: selector, role, accessible name, the heading it sits under, opening tag, text, box and a few computed styles. Claude answers in the terminal; the overlay shows whether each batch went in.

## Requirements

- Claude Code with mods, as [vellum](../vellum/README.md#requirements) needs them: the npm `latest` channel loads them by default. Where they are off (`--bare`, `--safe-mode`, `disableAllHooks`, an organization's policy) the two skills load but nothing starts.
- `bun` on the PATH: the server is a Bun script.
- An app served by Vite's dev server (Vite or Vite+). The overlay never reaches a build.
- A recent Chromium or Firefox.

## Install

```
/plugin marketplace add bengous/claude-code-plugins
/plugin install pinpoint@bengous-plugins
```

## Start

1. In the Claude Code session, run `/pinpoint:start`. It starts the session's server and prints its address.
2. Once per app, load the Vite plugin in `vite.config.*` (the start skill offers to make this change):

   ```ts
   import { homedir } from "node:os";

   const { pinpoint } = await import(`${homedir()}/.claude/pinpoint/vite.mjs`).catch(() => ({
     pinpoint: () => [],
   }));

   export default defineConfig({ plugins: [/* yours */, pinpoint()] });
   ```

   The server writes `~/.claude/pinpoint/vite.mjs` at each start, so the path stays the same across updates. Without it the `catch` loads nothing, and a build never runs the plugin (`apply: "serve"`).
3. Reload the page and press **Alt+P**.

The app's dev pages load the overlay of the newest session whose directory holds the app's root. A page loaded with no session running says in the console how to start one.

## Point

- **Alt+P** turns pointing on and off. While it is on, the app sees no click: a pick is not a click on the app.
- A **click** picks an element; inside an SVG, the whole `svg`. A **drag** draws a zone, which takes the outermost elements it covers (half of the element's box, or of what it draws, inside it).
- **Ctrl+click** or **Ctrl+drag** (⌘ on a Mac) adds to the selection being written. While Ctrl is held, the composer and the panel fade and let the click through.
- The composer offers the quick labels and a note. A **label** puts the selection in the batch at once, with the note typed so far. **Enter** puts it there with the note; **Shift+Enter** breaks the line; **Esc** drops it, and a second Esc turns pointing off.
- The composer opens beside what was picked. **Drag its top row** to move it out of the way: it stays pinned there, and every next composer of the tab opens at that place, across reloads, kept inside the window. **Unpin** in the composer forgets the place and opens it beside each pick again.
- **Ctrl+Enter**, or **Send (n)** in the panel, sends the whole batch; **Send** on a card sends that selection alone, **Remove** drops it. Hovering a card shows where its targets were.
- The panel's status line says where the last batch is: sent, delivered to the session, not delivered (its selections come back to the batch), or not sent (the server does not answer; nothing leaves the batch). The batch survives a reload of the page in the same tab. So does pointing: a page reloaded while it is on comes back with it on.

## Configure

- `pinpoint({ labels: ["Too tight", "Wrong color"] })` replaces the quick labels (`Misaligned`, `Too big`, `Too small`, `Wrong text`, `Remove`); `[]` offers none.
- `window.pinpointContext = () => ({ ... })`, set by the app in dev, rides with each selection as JSON: the route, the saved state a screen is built from, what Claude needs to see the same thing. It is cut past 10 000 characters.

## What a batch says

```
pinpoint batch 3: 2 selections the user made in their running app. Under each label and note, the lines are what the page reported.

1. [Too small] Must read from afar.
   page: http://localhost:5173/settings · "Settings" · viewport 1440 × 900 · scroll 0, 120
   element: body > main > form.settings > button.save
     role button · name "Save" · under "Account"
     <button class="save" type="submit">
     box x 1180, y 812, 96 × 32
     styles: font 500 13px/16px system-ui; color rgb(29, 36, 48); padding 6px 12px; display inline-flex
   app context: {"route":"settings"}

2. [Misaligned]
   zone: x 950, y 800, 420 × 90, 2 elements in it
     - body > main > form.settings > p.hint
       ...
```

Boxes are CSS pixels of the viewport at the pick. The page and the app context repeat only when they change. Claude Code shows the prompt as "Prompt from the pinpoint plugin" and hands it to Claude as "The pinpoint plugin sent a message:", a message to address (measured in a live session on Claude Code 2.1.301, Linux, 2026-10-16).

## How it works

```
app page (Vite dev) ──overlay.js, POST api/batch, events──▶ pinpoint server (Bun, 127.0.0.1, one per session)
                                                                  │ stdout: one JSON line per batch
                                                                  ▼
                                               hooks module ──$.prompt.submit──▶ the session
                                                                  │ POST api/delivery
                                                                  ▼
                                                     the page's status line: delivered
```

- `/pinpoint:start` spawns `server/cli.ts serve` as a child of the hooks module, on a free port with a fresh token, and keeps both in the plugin's store. A server that ends on its own comes back on the same port and token, so the page reconnects; three ends within a minute stop the revivals and the status line says so. A reload of the module starts the stored server again. `/clear` carries it over to the new session id. `/pinpoint:stop` ends it and removes its files.
- The server writes `~/.claude/pinpoint/sessions/<session>.json` (port, token, root, pid), which the Vite plugin reads at each page to inject `<script src="http://127.0.0.1:<port>/t/<token>/overlay.js">`. Every route sits behind the token in the path; a request whose `Origin` is not a page of this machine (`localhost`, `127.0.0.1`, `[::1]`) is refused, and the module's own routes refuse any page.
- A batch is numbered and kept on disk until the module reports it went in, so a server started again tells the session what it still holds; the module skips what it already handed over. The module relays batches one after the other, never in the loop that reads the server.
- The server exits after a minute without the module's heartbeat: a `claude` killed hard sends no signal.

### What it hooks

| Hook | Matcher | What it does |
|---|---|---|
| `session.start` | | Starts the server the store kept for the session again, after a reload. |
| `skill.prompt` | `skill=pinpoint:start` | Starts the server, or keeps the one running, and appends where it listens. |
| `skill.prompt` | `skill=pinpoint:stop` | Closes the server and forgets the session's record. |
| `command.run` | `command=clear\|resume` | Moves the record to the new session id, the server kept. |

### What it calls on `$`

| Call | What for |
|---|---|
| `$.process.spawn` | The server, read line by line for as long as it runs. |
| `$.prompt.submit` | Each batch, once the session is idle, in order. |
| `$.http.fetch` | The server's heartbeat, each batch's delivery, the close. |
| `$.store.get`, `$.store.set`, `$.store.delete` | The session's record: root, port, token, last batch relayed. |
| `$.session.id`, `$.session.root` | Which session the server serves, and the directory apps are found under. |
| `$.clock.after`, `$.clock.every`, `$.clock.now` | The start's timeout, the heartbeat, the crash window. |
| `$.ui.status` | The line under the prompt, for a server lost alone. |
| `$.ui.log` | Errors only: a server that did not start, a batch not relayed, a line the module does not read. |

`claude plugin validate pinpoint` prints both lists from the module's source.

## Limits

- Anything that can read `~/.claude/pinpoint/sessions/` can post a batch, as can any script running in the app's dev page: the token keeps out other sites, not your own processes. A batch is framed as the plugin's message, never as your own words.
- An image of a zone is not taken: the selection carries what the DOM says.
- Only Vite's dev server injects the overlay.
- On Claude Code Desktop, a prompt a plugin submits while the session is idle shows only once you type in the session ([anthropics/claude-code#96336](https://github.com/anthropics/claude-code/issues/96336)); the terminal is unaffected.

## Development

```bash
bun test pinpoint/                 # server, overlay and Vite plugin specs (*.spec.ts)
claude plugin test pinpoint        # the hooks module in the engine's kit (hooks/*.test.ts)
claude plugin validate pinpoint    # what the module hooks and calls
command claude --plugin-dir pinpoint   # a live session from source
```

The overlay is plain TypeScript in a shadow root, no framework: `overlay/main.ts` is the controller, `describe.ts` and `pick.ts` what an element is (adapted from vellum's `src/formats/html/`), `view.ts` what it draws, `tray.ts` the batch as a pure model. `shared/wire.ts` types everything that crosses a process boundary.

## License

MIT

## Author

Augustin BENGOLEA <bengous@protonmail.com>
