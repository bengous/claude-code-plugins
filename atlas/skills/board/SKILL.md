---
name: board
description: >
  Show an atlas map in the browser: the page of a map folder, or of one of its drafts, served while a session shows it; what the user selects there reaches this session. Only the user runs it.
disable-model-invocation: true
argument-hint: "[map folder] [draft name]"
---

# atlas board

The lines after this text are the atlas mod's. Tell the user what they say in one or two sentences.

- `atlas shows the map <folder>.`, then where its page is:
  - `Open <url> in your built-in browser, beside the conversation.`: open that address now with the session's built-in browser (the desktop app's Browser pane), so you both see the map.
  - `The system browser opens <url>`: the mod opened it; give the address in case no tab came up.
  - `Open <url> in a browser.`: give the address. If your session has a browser of its own (Claude in Chrome, agent-browser), open it there when you need to see the map.
- `atlas already shows the map <folder>.`: its page was up, at the same address.
- `Another session's server serves it`: two sessions show the same map from one server; nothing to do.
- `atlas found several map folders`: ask which one; the user runs `/atlas:board <map folder>`.
- Any other `atlas:` line: nothing is shown; say why in the line's words.

While the page is up:

- When the user selects a zone or a brick, their next prompt carries `On the atlas map <folder>, the human has selected <id> (<label>).`: that node is what "this" or "here" means.
- Four tools read and answer the map, each taking the map folder the lines above name: `mcp__atlas__atlas_query` (a node by its id: its path, children, links, panel fields and sources), `mcp__atlas__atlas_open_points` (the open points and who each waits for), `mcp__atlas__atlas_reply` (answer an open point as the agent; it then waits for the user), `mcp__atlas__atlas_check` (validate the data after an edit).
- The data lives in the folder's `map.ts`; a save reloads the page, and an error shows there with its file and line.
