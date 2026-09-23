---
paths:
  - "src/core/page/**"
  - "src/extensions/**"
---

# The page and its renderers

`src/core/page/` is the Preact page: `api.ts` the client (token, routes, SSE), `state.ts` the store of
signals, `kit.tsx` the components every other `.tsx` draws with, `*.tsx` the rest of them,
`style.css` and `fonts/` the design system, `anchoring.ts` and `highlights.ts` the text selection,
`editor.tsx` and `caret.ts` the plan's source editor, `labels.ts` what the page names, a
document, a place, a quote, purely, so it is tested without the store. The renderers are the page halves of
the extensions; what an extension is and how one is added is `extensions.md`, which loads
with the same files. One bundle is a browser's: `Bun.serve` builds it from
`src/core/page/index.html` at the first request for the page,
no build step, so what the page imports costs nothing at `cli start`.

- `src/core/page/` and `src/extensions/` never import `src/core/server/app` or
  `src/core/server/adapters`; they depend on `src/core/protocol.ts`, on `src/core/extension.ts`
  and on the domain's pure `paths.ts`. `src/core/server/` never imports the page beyond
  `index.html`. What an extension may import, and how one is added: `extensions.md`. Held by
  `src/boundaries.spec.ts`.
- `style.css` is the one place a colour is written: its `:root` and its dark block, which
  redefines every base token but `--paper` and `--outline`, the two surfaces the theme does not own. Every other surface derives with `color-mix()`, and every size
  is a token of the three scales (`--t-*`, `--s-*`, `--r-*`). Two families, one rule: prose is
  `--serif` (Literata), code and literals (a path, a version, the diff count, a key) are
  `--mono` (JetBrains Mono), and the chrome reads as prose. The fonts ship in `fonts/`, each
  under the bundler's inlining threshold, so they arrive inside the CSS chunk.
- A button, badge, chip, tag, banner, popover, dialog, chevron, handle or switch is drawn through
  `kit.tsx`, never through one of its classes spelled at the call; `kit.tsx` is in `PAGE_SURFACE`,
  so an extension draws with the same ten. A `Chip` is a button; what shows a label and takes no click is a `Tag`.
  The types hold part of it, locked in `kit.spec.ts`: `ChipProps` takes no `class`, and neither
  takes `className`. `ButtonProps` takes a `class`, joined to the kit's own, for a state the kit
  has no prop for (`grill-later` in `grill/proposal.tsx`): there a kit class spelled at the call compiles,
  and only a reader refuses it. A `Chip`'s state the kit has no `tone` for rides on a `data-`
  attribute its extension's CSS reads under the extension's prefix (`data-state` in
  `.grill-chips`), and says it in words in its `title`, since a colour says nothing to a screen
  reader. A token consumed outside CSS (Mermaid's `themeVariables`, the frame's overlay) parses
  neither `color-mix()` nor the `oklab()` the browser serializes once computed: it goes through
  `srgb()`, which yields sRGB, and the consumer redraws on the `dark` signal of `state.ts`.
- A commented block carries a fillet in the sheet's margin: `markdown/marked.ts` chooses,
  purely, the innermost block of each commented line, and `page.tsx` toggles `marked` on it.
- The screen names nothing of the server's: `labels.ts` says `Plan v2` for the version's file,
  `line 3` for a passage, an element's label for a selector, a code block by its first line, a
  diagram by its kind (`Passage.kind` says which), and a rail line by its name and the folders
  that tell it from its neighbours. The cards read in the document's order, then by line; a
  card hovered or focused is `focused` of `state.ts`, and the plan's renderer paints its passage
  (`::highlight(vellum-focus)`), scrolling to it on a click; a comment added scrolls the list
  to its card. The general box comments the plan when the document beside it takes none.
- Everything crossing `/api` is JSON and typed in `src/core/protocol.ts`; a new field lands there
  first. What crosses `/api/x/<id>/` is the extension's own, typed in its `protocol.ts`.
- A chain of tests over a union of `src/core/protocol.ts` ends on a function whose parameter is
  the members left, never on a bare `return`: over `MediaType`, what is neither Markdown nor
  HTML goes to a function that takes `` `image/${string}` ``, so a member added to the union
  stops compiling there instead of being labelled an image. A `Record` cannot hold this union,
  one member is a template literal. No code carries such a chain today.
- `strict` lets through an `any` that a library's overload returns, and oxlint reads no types:
  `response.json()`, `JSON.parse`, and `Object.fromEntries` over pairs that lost their tuple type,
  which an array literal returned from a callback does. The constant that receives one carries
  its type: `attributes` in `markdown/vnode.ts` is annotated as pairs, or `given` is `any` and
  spreads into the props of every node. To check a doubt, `const probe: number = <value>` must
  fail `bun x tsgo --noEmit`.
- `app.tsx` is the one file that reads the registry: it picks the renderer and hands the
  extensions' `actions` to the decision bar, which draws them before its own buttons. An action
  that follows the workspace reads `review` and loads its own state again at every change.
- The body is panes, left to right in the order `panesOf` of `panes.ts` gives, purely: the
  document pane (`Panes`, where the rail's choice and `split` show) and each extension's `panel`
  while its `shown()` holds. The order is data, `PANE_ORDER`, written nowhere else until settings
  exist; a shown panel it omits comes after, right of the documents. A panel draws its own
  element and width. The gutters go by place, never by pane: the rail's handle sits left of the
  first pane and the comments' right of the last, whichever pane is there (`guttersOf`, pure).
  `app.tsx` draws each pane in a slot of `display: contents` that hands it `--gutter-start` and
  `--gutter-end`, and the pane pads with them where it scrolls: `.panes` for the documents,
  `.grill-panel` for the grill.
- A renderer that declares `comments: false` draws a document that takes no comment, as a
  grill's transcript, read-only since the grill's panel is where it is answered: `app.tsx` then
  draws no switch and no comments panel, unless the plan shows beside it. The unsent comments
  stay in the signals, and the bar keeps their count.
- Both side panels fold, each on a signal of `state.ts`: the comments panel on `commentsOpen`,
  the document rail on `railOpen`. `comments.tsx` and `doc-list.tsx` put `folded` on their panel
  and draw its control, `CommentsHandle` and `RailHandle`, both through the kit's `Handle`, which
  `app.tsx` places on the panel's edge inside `.body`. The comments panel's CSS takes its width
  to zero; the rail slides out by the left, a negative `margin-left` that `.app` clips, so its
  lines never reflow while it moves. A fold never unmounts a panel; a renderer with
  `comments: false` still unmounts the comments panel, as above. An extension's panel appearing
  folds the comments panel, its handle kept, since four columns do not fit a laptop: `app.tsx`
  does it, as layout, and no extension writes `commentsOpen`. That fold is drawn at once, with
  no slide (`commentsSnap`, which the handle clears so the reviewer's own folds slide): a panel
  is known only once its extension has loaded, after the first render, so a page loaded with a
  grill open shows the comments open until then, and a slide there reads as the page jumping.
  `shell.e2e.ts` records every width transition of `#comments` to hold it. Folded, a panel is `inert`: what leaves the screen hides pixels, not
  focus. The comments handle's badge is the unfiltered total, the one count a folded panel still
  shows. The rail's carries none, though folded the rail hides each document's count and any
  document Claude writes meanwhile: it opens at every load, and only the reviewer folds it.
  `readWindow` of `state.ts` sets `commentsOpen` from `(max-width: 900px)`, once a load, the
  threshold `style.css` repeats in the media query where an open comments panel lays over the
  document. It leaves `railOpen` open at every width: the rail is how a document is chosen, so
  folded it costs a click at each change, and under 900px it keeps its place beside the
  document, where a rail laid over it would have to fold again after each choice. Under 900px the
  open comments panel and its handle paint over the rail's handle, one `z-index` below, so on a
  narrow window the comments fold first.
- The page draws in every state, `drafting` included. `review.docs` is a list of `GroupedDoc`:
  the server, the one place that knows where a file came from, labels each `"plan"`,
  `"artifact"` (a renderable file of the working directory) or `"cited"` (a file the plan links
  outside it), and the rail filters on that label, never on a path. While `drafting` the working
  copy `plan.md` heads the list as `"plan"`; once a version exists the plan is `review.plan`,
  which `planDoc` of `state.ts` puts at the head with the same label. A reader finds the plan by
  that label, as `DocList` does, or by `planDoc`'s path, never by its place in `docs`. Past
  `drafting` the working copy is on no list, and `review.plan.workingCopy` names it, since the
  server is again the one that knows the two are one document. The choice is `linkedDoc` of
  `markdown/links.ts`, three answers read in order: a listed document named in full, then the
  working copy, which selects the plan, then a listed document the name only ends. So `plan.md`
  selects the plan as it does while `drafting`, and a link the page holds no document for keeps
  the new tab its anchor carries. Comments are taken while `inReview` and while `drafting`, so
  `locked` names two states, not one, and Approve is drawn only where a version exists. `locked`
  reads `takesComments`, the domain's predicate the server holds a draft to as well. A renderer
  never reads `commentSwitch`: it reads `commenting`, false on a locked page, so no composer
  opens there, and `addAnnotation` returns when locked, as `select` does while the editor is
  open. A comment nobody can send is a silent loss.
- `review.held` is what holds the review, or `null`, in the holder's words (`holds` of the
  grill answers `grill 2 is open`, by the transcript's number). The reason is also the hold's
  identity: the approval notes remember the one they warned of, and a reason that differs brings
  the warning back, so a second grill must not read as the first. Held, the pill reads `Held · <reason>` (`statusOf`), in
  review only, Send feedback is disabled with the reason as its title, and every way to an
  approval goes through the warning popover, which frames the reason in its own sentence (`The
  review is held: <reason>.`), since a reason reads as a clause, then says the approval ends it. The
  core draws no notice of it, `noticesOf` takes no hold: the extension that holds draws its own,
  the grill's band. The bar prints the reason and never reads which extension gave it.
- What the page says of its state is derived, in `notices.ts`, pure and held by
  `notices.spec.ts`: `noticesOf` the column under the bar, `statusOf` the pill, `decisionsOf`
  the three buttons of the core, greyed or not and why, the reason in each `title`. Nothing
  writes a sentence into a signal: a request that fails is a `Failure` of its operation, through
  `fail` of `state.ts`, one per operation, and the next success of that operation removes it
  (`succeed`); the stale editor derives from `editing` and the version, so its notice leaves
  with the editor; a card's Delete leaves an `undo` for a while. `app.tsx` draws the column with
  `Notices`, the core's first, then each extension's `notices` components: the grill's proposal
  is one, a `Dialog`, shown while it is mounted, and its band another, drawn while a grill is
  open: the subject, the round, the questions that wait for the reviewer, open and untouched in the draft as the chips count them, and End grill, the page's one. Its
  count alone is `role="status"`, drawn empty with none waiting, so a new count is read out and
  End grill never is. The band carries the grill, so the Grill button hides meanwhile. A modal never opens under a typing: the editor
  open, a popover up (`popoverUp` of the kit) or a field focused, `showModal()` would take the
  focus and make the page inert, so the next Enter of a comment would answer the modal. A
  proposal that lands there is put off at once, a dot on the Grill button (`askingOn` and
  `modalOf` in `grill/modal.ts`, pure), and so is one that lands while the modal is up: what the
  modal shows never changes under the reviewer. On an approved page none shows, whatever the server holds.
  An extension's own button computes its greyed state and its `title` itself (`GrillAction`).
  A notice of kind `err` is `role="alert"`, the others `role="status"`; a literal in one comes
  as `{ code }` and is drawn in `<code>`. In `approved` the bar draws no button.
- A module of the page reads the browser inside a function, never at its own scope, so a
  `bun:test` suite imports the store, the renderers and every component but the three `app.tsx`
  keeps to itself (`App`, `Panes`, `Doc`): `api.ts` reads the token off `location` at each call,
  and `readWindow` of `state.ts` reads the window's width once and follows its colour scheme. Two
  scripts are exempt, since a browser runs them for what they do at that scope:
  `app.tsx` and `html/frame.ts`. `app.tsx` calls `readWindow` before the first render, never from
  `start`: `Comments` draws `commentsOpen` at that render and `start` runs in an effect after it,
  so under 900px the panel would paint open, then fold through its width transition. `shell.e2e.ts`
  holds that call: in a 900px window it records each class `#comments` takes from before the
  page's scripts run, and finds the panel folded from the first render. The rest is held by
  `src/boundaries.spec.ts`, which imports every other module in a process with no `window` and
  names the file that throws.
- `start` is the page's one way in, and its order is the rule: the saved draft into the signals,
  then the first load, then the saving effects, then the event stream. Nothing may `PUT` a draft
  before the restore, or every reload replaces the file with the page's empty state. After it,
  each change of the comments or of the edit is one write, sent in order; signals that change
  together change in one `batch`; a change of `typed` is written once the typing pauses
  (`TYPED_WRITE_MS`), and a write of the comments or of the edit meanwhile carries it.
  `state.spec.ts` holds this at the page's ports, a fake `fetch` and a fake `EventSource` that
  log what reaches them: the restore before the first load, no write while that load is out, the
  stream after it, one write for each `batch` a saving page runs, and one write for a continuous
  typing. The saving effect against the stream is one synchronous step, which no port tells apart.
- What is typed and not submitted is `typed` of `state.ts`, one `Typed` of the draft, and
  `setTyped` its one writer: the general box, the composer's text by document, a grill's answers
  and note by transcript, the editor's typing by version. No component keeps a text in a
  `useState`: what is typed survives the pane that unmounts and the reload, and a composer or an
  editor opened again on the same document or version starts with it, though neither reopens by
  itself. A typing whose field is gone goes with it, or the warning would name what nobody can
  see or clear: a grill's answers once the server says no grill is open on the transcript
  (`forgetClosed` in `grill/page.tsx`), the editor's typing once its version is no longer under
  review (`settleEditorTyping`). A grill's answer keeps the draft's shape: absent, the question
  takes the recommendation by default; `As recommended.` (`AS_RECOMMENDED` of
  `grill/protocol.ts`), the reviewer chose it; any other text is their own. The panel's two
  choices write it, Recommended the default, and a text of the reviewer's own greys Recommended,
  so a click never throws the typing. The choice is read off the draft when the question shows,
  then held by it, so a text typed through `As recommended.` stays the reviewer's. `unsentTyped` names what a decision would throw; Send feedback
  and Approve put the warning first when it is not empty, and a decision that lands clears it. Cancel of the editor
  over a changed text asks first; End grill sends what is typed as a reply before it closes.
- An unsent edit is an `Edit`: a text with the version it edits. The stamp is taken when the
  editor opens, and `Editor` keeps that version and its base text for its whole session: a
  version that lands under an open editor must not restamp it. They travel as one `EditSession`,
  from `editing` to `Editor` to `finishEdit`, never unpacked: the base and the typed text are two
  strings, and swapped they compile, invert the line diff and record the old text as the edit. Every load settles the edit
  through `editOnLoad` (kept, landed, stale), a restored one included, which is why the restore
  comes before the first load. The editor never closes by itself and nothing Claude does clears
  the reviewer's comments: a stale edit is dropped with a notice (a `Failure` of op `edit`),
  never silently, and Done on a version that moved is greyed under the notice `staleEditor`
  derives, the editor open so the typing can be copied.
- One line diff, computed once: `planChanges` in `state.ts` compares the previous version with
  the text on screen, the bar prints its count, and the plan's renderer marks it while
  "Changes since" is on. On Done `shiftAnnotations` moves the plan's comments through the edit,
  from the three texts of the session (the version's, the one the editor opened on, the one
  typed), so a feedback only ever names lines of the text it is sent with. A passage stands in
  one of three places, which `standingOf` in `diff.ts` reads, derived and never stored: on the
  version's lines, over a line only the edit holds, or `removed`. A removed line is replaced
  when an added run follows its run, one removed line per added line, the ones sharing the
  most words with them, the first on a tie (`replacedIn`); the rest of the run is removed
  outright (`lineMap`). So a line added beside a line the edit changed, or below the last line
  of a plan with no final newline, is the edit's. A passage on a line the edit replaced is on
  the version's lines and follows the replacement; one on the version's lines whose lines the
  edit removed outright is `removed` and takes the version's lines, whatever edit it was made
  on, and the card, the feedback and the sheet say so, the sheet by marking nothing; a
  `removed` passage is judged against the version again at each Done, and comes back once its
  text does. A passage over a line only the edit holds has no version's lines to take, so it
  is never `removed`: it goes with the first Done that removes any of its lines, and a comment
  left with no passage goes whole. That Done asks nothing, since the text it took was the
  reviewer's own and no version held it. Discard edit is `discardEdit` through
  `unshiftAnnotations`, a Done that types the version's text back: a passage over a line only
  the edit holds goes with it, and a comment left with no passage goes whole. Its confirmation
  counts those comments before the click (`goneOnDiscard`), since Discard edit clears Delete's
  undo and no notice after it could bring them back. The editor closes through `closeEditor` alone, Done and Cancel alike, on the line
  under the caret: `resume` carries it, the plan's renderer scrolls to its block once the diagrams are drawn and the images decoded,
  and `Tools` gives the focus back to Edit. While the editor is open the comments panel stays
  readable and scrolls: its actions are disabled, not the panel.
- `EventSource` reconnects by itself, so the page polls nothing: `subscribe` reports `error`
  and `open`, `connection` keeps `up | down`, and the column draws the lost-connection notice
  while `down`, the three decisions and Grill greyed meanwhile. A server revived on the same
  port and token clears it with no reload; past `NEW_LINK_HINT_MS` the notice names
  `/vellum:start`, the one way to a link that works.
- The server watches the working directory, so every file Claude writes reaches the page as a
  workspace event. A renderer loads its document through `docUrl`, whose query is the file's
  `modified`: a rewrite reloads that document alone, and nothing else remounts.
- What the reviewer waits on fails in the notices, through `fail` of `state.ts`, as the core's
  own requests do: a write (`post` in `grill/page.tsx`, op `send`) and a document's load
  (`sourceOf` in `markdown/page.tsx`, op `load`, `blocksOf` in `grill/page.tsx`, op
  `extension`), two ops so a load that succeeds leaves a refused write in the notices. A load checks
  `response.ok` before it reads the body, or the server's error page is drawn as the document and
  takes comments, and it catches, or an aborted request reaches nobody. A read that only
  refreshes what is on screen may fail in silence, since the next workspace event reads again:
  `loadState` in `grill/page.tsx`, which keeps the state it read last, and the open transcript's
  blocks with it, so the grill's panel and its band stay as the reviewer left them, the Grill
  button hidden behind the band, but for an approved page, where the approval closed the grill
  (`drawn`), while the Grill button and the modal read none past a refused
  read (`read`), which puts the modal on screen off onto the dot. `decide` answers whether the server took the decision, and
  the notes popover closes on that alone: a failure leaves the note where it was typed.
- In the Markdown renderer the notice says the failure and the sheet says the state it leaves: a
  first load that failed prints it where the wait was, a failed reload keeps the text the reviewer
  is reading. `waitingText` in `markdown/sheet.ts` chooses, purely, and `MarkdownDoc` draws it in
  the one `.waiting` line it already had. No other renderer has that state: a grill's transcript
  whose blocks failed to load stays an empty sheet under the notice. The grill's panel draws the
  transcript's text, then every round's questions as chips over the one question they pick, an
  open one with its two choices, an answered one read-only (`roundsOf` in `grill/rounds.ts`,
  pure, on the blocks as served); its send says how many open questions it takes as
  recommended. Send round and End grill wait on one reply (`replying`), from the click until the
  transcript shows it, so neither sends what is typed twice nor over blocks read before it. While Claude works on a round the panel carries a `role="status"` line, and a
  round that lands shows its first open question, scrolled into view.
- A block says its source lines in `data-lines="start-end"`: `markdown/tree.ts` writes it,
  `parseLines` of `anchoring.ts` is the one place it is read, and `tree.spec.ts` holds the two
  together. Every reader calls it, the pure helpers of `markdown/` included: a second copy of
  the pattern is a second format. A captured group becomes a number through `Number.parseInt`,
  which takes a string only; `Number(match[1])` compiles on the `undefined` that
  `noUncheckedIndexedAccess` had just named, and answers `NaN`.
- A `mermaid` block reaches the page as an empty `figure` carrying its lines and its source, and
  Mermaid fills it after the mount: the figure is the one place a renderer writes DOM that Preact
  does not own, and `data-source` is both what a comment on it quotes and what a late render
  checks before it writes. Its comment boxes the figure, since the SVG holds no text to highlight.
- A removed run is drawn as a `details.removed` that holds no text node: its label and its old
  source are attributes, drawn by CSS `content: attr()`. So it takes no pick, and never enters
  the quote search of `anchoring.ts`. `markdown/changes.ts` chooses, purely,
  which block carries a mark and where a removed run goes: inside the `li` that follows it,
  after its checkbox, before the `tr` for a row, where `markdown/vnode.ts` draws it as a row of
  its own, never directly under `ul`, `ol`, `tbody` or `tr`; for a `pre` it also names the added
  lines by their index, which `markdown/vnode.ts` draws as bands over the block.
- An HTML file is served with a sandboxed CSP, so the page cannot reach into it: `html/frame.ts`
  runs inside the mockup and owns the selection there, the page only sends it whether the page
  comments, the Ctrl state, the places already commented (a selector, the text chosen in it and
  the characters around that text, which the mark boxes where they fit best while the text is
  there, the whole element otherwise), the pointer
  leaving the iframe, and the theme, five tokens resolved to sRGB since its shadow root reads
  none of the page's properties. The root is open: the mockup's own scripts could remove the
  host anyway, and the browser suite reads the overlay through it. `html/messages.ts` is the
  contract both sides import; every message crosses with the target `"*"` and each side checks
  `event.source`.
  That check proves the window, not the sender: `frameTag` in `http/routes.ts` adds `frame.js` to
  every HTML file served, so the mockup's own scripts, the model's, post from the same window.
  Those scripts can post `vellum:switch` as they can post `vellum:pick`, an accepted risk: the
  mockup is the model's own document under review, and at worst the switch flips under the reviewer.
  The page reads a frame's message through `parseFrameToPage` of `html/parse.ts` and drops what
  is not a whole `FrameToPage`; `frame.ts` casts, since the sender it verified is the page.
