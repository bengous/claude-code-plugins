# pinpoint

Point at your running app and talk to Claude. In your app's dev build, an overlay lets you pick an element by a click or a zone by a drag, give it a quick label or a note, and keep it in a batch. You send the batch when you are done, and it reaches the Claude Code session as one prompt, each element described precisely enough to find it in the code: selector, role, accessible name, the heading it sits under, opening tag, text, box and a few computed styles. Claude answers in the terminal; the overlay shows whether each batch went in.

## Requirements

- Claude Code with mods, as [vellum](../vellum/README.md#requirements) needs them: the npm `latest` channel loads them by default. Where they are off (`--bare`, `--safe-mode`, `disableAllHooks`, an organization's policy) the two skills load but nothing starts.
- `bun` on the PATH: the server is a Bun script.
- An app you run on this machine, served over `http(s)`: a dev server (Vite, Next, Rails, Django, Storybook…) or any other. The overlay reaches it through the session's address only; the app's files are not touched.
- A recent Chromium or Firefox.

## Install

```
/plugin marketplace add bengous/claude-code-plugins
/plugin install pinpoint@bengous-plugins
```

## Start

1. In the Claude Code session, run `/pinpoint:start`. It starts the session's server and prints its address, `http://localhost:<port>/`.
2. Open that address. "Which app?" lists the apps answering HTML on the usual dev ports of this machine (3000 to 3005, 4000, 4173, 4200, 4321, 5000, 5173 to 5179, 6006, 8000, 8080, 8081, 8888, 9000), each by its page's title, and takes any other address. A port that took the connection but did not answer within the second, as a dev server compiling its first page, is listed too, marked so. Click one: the address now serves that app, with the overlay.
3. Press **Alt+P**.

`/pinpoint:start <url>` serves that app at once: a URL, `localhost:3000/admin`, or a port alone. Run it again with another URL to switch apps; the address stays the same, so the open tabs show the new app once reloaded. The app chosen comes back with a server the module revives. The server refuses its own address, which would serve itself.

### On the app's own Vite address

The Vite plugin still loads the overlay in a Vite app's dev pages at their own address, once per app in `vite.config.*`:

   ```ts
   import { homedir } from "node:os";
   import { join } from "node:path";
   import { pathToFileURL } from "node:url";

   const { pinpoint } = await import(
     pathToFileURL(join(homedir(), ".claude/pinpoint/vite.mjs")).href
   ).catch(() => ({ pinpoint: () => [] }));

   export default defineConfig({ plugins: [/* yours */, pinpoint()] });
   ```

   The server writes `~/.claude/pinpoint/vite.mjs` at each start, so the path stays the same across updates. Without it the `catch` loads nothing, and a build never runs the plugin (`apply: "serve"`). The import takes a `file://` URL because an ESM import of a bare Windows path (`C:\...`) fails, and the `catch` would hide it.

The app's dev pages load the overlay of the newest session whose directory holds the app's root. A page loaded with no session running says in the console how to start one.

## Point

- **Alt+P** turns pointing on and off. While it is on, the app sees no click: a pick is not a click on the app.
- A **click** picks an element; inside an SVG, the whole `svg`. A **drag** draws a zone, which takes the outermost elements it covers (half of the element's box, or of what it draws, inside it).
- **Ctrl+click** or **Ctrl+drag** (⌘ on a Mac) adds to the selection being written. While Ctrl is held, the composer and the panel fade and let the click through.
- The composer offers the quick labels and a note. A **label** puts the selection in the batch at once, with the note typed so far. **Enter** puts it there with the note; **Shift+Enter** breaks the line; **Esc** drops it, and a second Esc turns pointing off.
- The composer opens beside what was picked. **Drag its top row** to move it out of the way: it stays pinned there, and every next composer of the tab opens at that place, across reloads, kept inside the window. **Unpin** in the composer forgets the place and opens it beside each pick again.
- **Send (n)** in the panel sends the whole batch, and so does **Ctrl+Enter** while pointing; with pointing off, Ctrl+Enter is the app's. **Send** on a card sends that selection alone, **Remove** drops it. Hovering a card shows where its targets were.
- The panel's status line says where the last batch is: sent, delivered to the session, not delivered (its selections come back to the batch), not sent (the server does not answer; nothing leaves the batch), or unknown to the server (it keeps what became of the last hundred batches only). Each tab hears only of the batches it sent. The dot before the panel's name says whether the server answered the tab's last question.
- The batch, and the batches still waiting, survive a reload of the page in the same tab: a reloaded page says the last one waiting, then what became of it. So does pointing: a page reloaded while it is on comes back with it on.

## Configure

- `pinpoint({ labels: ["Too tight", "Wrong color"] })`, in the Vite plugin, replaces the quick labels (`Misaligned`, `Too big`, `Too small`, `Wrong text`, `Remove`); `[]` offers none. Through the session's address, the quick labels are those.
- `window.pinpointContext = () => ({ ... })`, set by the app in dev, rides with each selection as JSON: the route, the saved state a screen is built from, what Claude needs to see the same thing. It is cut past 10 000 characters.

## What a batch says

```
pinpoint batch 3: 2 selections the user made in their running app. Under each label and note, the lines are what the page reported; boxes are in page pixels, from the top-left corner of the document.

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

Boxes are in page pixels, from the top-left corner of the document, each measured at its pick: a scroll between two picks, or before the selection goes in the batch, moves none of them. The page line's scroll is where the user stood when the selection went in the batch. The page and the app context repeat only when they change. Claude Code shows the prompt as "Prompt from the pinpoint plugin" and hands it to Claude as "The pinpoint plugin sent a message:", a message to address (measured in a live session on Claude Code 2.1.301, Linux, 2026-10-16).

## How it works

```
app page (at the session's address, or Vite dev)
   │ overlay.js, POST api/batch         ▲ GET api/outcomes: pending, delivered, dropped, unknown
   ▼                                    │
pinpoint server (Bun, 127.0.0.1, one per session) ──every other request──▶ the app
   │ stdout: one JSON line per batch    ▲ POST api/delivery: delivered or dropped
   │ and per app chosen                 │ POST api/target: the app to serve
   ▼                                    │
hooks module ──$.prompt.submit──▶ the session
```

- `/pinpoint:start` spawns `server/cli.ts serve` as a child of the hooks module, on a free port with a fresh token, and keeps both in the plugin's store, with the app it serves. A server that ends on its own, or whose output stops being readable, comes back on the same port and token, serving the same app, so the app's pages reach it again where they loaded it from; three ends within a minute make it lost and the status line says so. A reload of the module starts the stored server again. `/clear` carries it over to the new session id.
- The app is the server's to hold. `/pinpoint:start <url>` passes it as `--target` to a server it starts, or posts it to `api/target` of the one running; the "Which app?" page posts its form to `/t/<token>/pick`, which takes a post from that page's own origin only, and only while no app is served: once one is, the app's own scripts share the origin, and only the module switches it. Either way the server checks the address against its own once bound, serves the app from then on, and says so on stdout, which the module records for the next revival. Each request it forwards carries a header only this server knows; one that comes back to it, through an address that names the server under another name (`localhost.`, an IPv4-mapped address, a hosts file alias), is answered 508 instead of forwarded again.
- The module holds one state: `idle`, `starting`, `live`, `stopping` or `lost`. A way in while the server starts or stops starts no second one. `/pinpoint:stop` enters `stopping` before anything else, so the end it causes revives nothing; it closes the server, which removes its files, or runs `cli.ts clean` when no server is left to close (lost, still starting, or not answering), then forgets the record. After each wait (a prompt entering, a store write, a server starting) the module goes on only while the state is still the one it started from, so a stop meanwhile leaves no record behind and starts no server.
- The server writes `~/.claude/pinpoint/sessions/<session>.json` (port, token, root, pid), which the Vite plugin reads at each page to inject `<script src="http://127.0.0.1:<port>/t/<token>/overlay.js">`. The server's own routes sit behind the token in the path. Until an app is chosen, `/` is the "Which app?" page, which probes the usual dev ports at `localhost` in parallel, for a second at most, keeps those answering HTML with their page's first `<title>`, read up to its end only, and those still silent. Once one is, the server sends every other request to that app's origin: an HTML page comes back with the overlay's tag at the end of its body, any other answer as the app gave it, and its WebSockets, Vite's hot reload among them, are relayed both ways. A request whose `Host` is not a name of this machine (`localhost`, `127.0.0.1`, `[::1]`, any port) is refused, which keeps out a page whose name was rebound to 127.0.0.1; so is a request whose `Origin` is not a page of this machine; and the module's own routes refuse any page.
- A batch is numbered and kept on disk until the module reports it went in, so a server started again tells the session what it still holds. Batches are numbered, kept and written to stdout one at a time, so their lines come in the order of their numbers.
- What the module reports of the last hundred batches stays on disk too, across a server started again. A page asks `GET api/outcomes` after the batches its tab sent and not yet settled, every second while one waits, then forgets each one settled; with none waiting, a visible page asks after nothing every ten seconds, which keeps its dot true. A batch the server answers `unknown` for is said once and asked after no more. No page holds a connection open, so a browser's few connections per host stay free for the overlay and the batches of every tab.
- What the session was handed belongs to its tenure, from the start or the restore after a reload to the stop, carried across every server a revival replaces: the last batch handed over, which a batch told again does not pass, and one queue that relays the batches of all its servers one after the other, never in the loop that reads a server.
- The server exits after a minute without the module's heartbeat: a `claude` killed hard sends no signal.

### What it hooks

| Hook | Matcher | What it does |
|---|---|---|
| `session.start` | | Starts the server the store kept for the session again, after a reload. |
| `skill.prompt` | `skill=pinpoint:start` | Starts the server, or keeps the one running, serving the app the URL typed after it names (the `ARGUMENTS:` line Claude Code ends the skill's text with), or switches the running one to it; appends the address to open. |
| `skill.prompt` | `skill=pinpoint:stop` | Closes the server, or removes its files when none is left, and forgets the session's record. |
| `command.run` | `command=clear\|resume` | Moves the record to the new session id, the server kept. |

### What it calls on `$`

| Call | What for |
|---|---|
| `$.process.spawn` | The server, read line by line for as long as it runs. |
| `$.process.run` | `cli.ts clean`, at `/pinpoint:stop` with no server left to close: the session's files. |
| `$.prompt.submit` | Each batch, once the session is idle, in order. |
| `$.http.fetch` | The server's heartbeat, each batch's delivery, a switch of the app, the close. |
| `$.store.get`, `$.store.set`, `$.store.delete` | The session's record: root, port, token, the app served, last batch relayed. |
| `$.session.id`, `$.session.root` | Which session the server serves, and the directory apps are found under. |
| `$.clock.after`, `$.clock.every`, `$.clock.now` | The start's timeout, the heartbeat, the crash window. |
| `$.ui.status` | The line under the prompt, for a server lost alone. |
| `$.ui.log` | Errors only: a server that did not start or could not be read, a batch not relayed, a line the module does not read, files not removed. |

`claude plugin validate pinpoint` prints both lists from the module's source.

## Limits

- Anything that can read `~/.claude/pinpoint/sessions/` can post a batch, as can any script running in the app's dev page, or in a page the server serves from its target, whose HTML carries the token: the token and the `Host` and `Origin` checks keep other sites from reading what the server serves or posting a batch, not your own processes. A batch is framed as the plugin's message, never as your own words.
- An image of a zone is not taken: the selection carries what the DOM says.
- "Which app?" finds only the apps on its list of ports, at `localhost`; any other takes its address in the field or after `/pinpoint:start`. A probe asks each app for its `/`, which a dev server may compile on the way; the page reuses a probe for five seconds.
- On Claude Code Desktop, a prompt a plugin submits while the session is idle shows only once you type in the session ([anthropics/claude-code#96336](https://github.com/anthropics/claude-code/issues/96336)); the terminal is unaffected.

## Development

```bash
bun test pinpoint/                 # server, overlay and Vite plugin specs (*.spec.ts)
claude plugin test pinpoint        # the hooks module in the engine's kit (hooks/*.test.ts)
claude plugin validate pinpoint    # what the module hooks and calls
command claude --plugin-dir pinpoint   # a live session from source
```

The overlay is plain TypeScript in a shadow root, no framework: `overlay/main.ts` is the controller, `describe.ts` and `pick.ts` what an element is (adapted from vellum's `src/formats/html/`), `view.ts` what it draws, `tray.ts` the batch as a pure model. `shared/wire.ts` types everything that crosses a process boundary; `shared/registry.ts` reads a registry entry for the server and the Vite plugin alike.

## License

MIT

## Author

Augustin BENGOLEA <bengous@protonmail.com>
