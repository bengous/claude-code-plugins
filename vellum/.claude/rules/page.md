---
paths:
  - "src/core/page/**"
  - "src/extensions/**"
---

# The page and its renderers

`src/core/page/` is the Preact page: `api.ts` the client (token, routes, SSE), `state.ts` the store of
signals, `kit.tsx` the components every other `.tsx` draws with, `*.tsx` the rest of them,
`style.css` and `fonts/` the design system, `anchoring.ts` and `highlights.ts` the text selection,
`editor.tsx` and `caret.ts` the plan's source editor. The renderers are the page halves of
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
  redefines every base token. Every other surface derives with `color-mix()`, and every size
  is a token of the three scales (`--t-*`, `--s-*`, `--r-*`). Two families, one rule: prose is
  `--serif` (Literata), code and literals (a path, a version, the diff count, a key) are
  `--mono` (JetBrains Mono), and the chrome reads as prose. The fonts ship in `fonts/`, each
  under the bundler's inlining threshold, so they arrive inside the CSS chunk.
- A button, badge, chip, tag, banner, popover or chevron is drawn through `kit.tsx`, never through
  one of its classes spelled at the call; `kit.tsx` is in `PAGE_SURFACE`, so an extension draws
  with the same seven. A `Chip` is a button; what shows a label and takes no click is a `Tag`.
  The types hold part of it, locked in `kit.spec.ts`: `ChipProps` takes no `class`, and neither
  takes `className`. `ButtonProps` takes a `class`, joined to the kit's own, for a state the kit
  has no prop for (`lit` in `grill/page.tsx`): there a kit class spelled at the call compiles,
  and only a reader refuses it. A token consumed outside CSS (Mermaid's `themeVariables`, the frame's overlay) parses
  neither `color-mix()` nor the `oklab()` the browser serializes once computed: it goes through
  `srgb()`, which yields sRGB, and the consumer redraws on the `dark` signal of `state.ts`.
- A commented block carries a fillet in the sheet's margin: `markdown/marked.ts` chooses,
  purely, the innermost block of each commented line, and `page.tsx` toggles `marked` on it.
- Everything crossing `/api` is JSON and typed in `src/core/protocol.ts`; a new field lands there
  first. What crosses `/api/x/<id>/` is the extension's own, typed in its `protocol.ts`.
- A chain of tests over a union of `src/core/protocol.ts` ends on a function whose parameter is
  the members left, never on a bare `return`: `kindOf` in `doc-list.tsx` hands what is neither
  Markdown nor HTML to `imageKind`, which takes `` `image/${string}` ``, so a member added to
  `MediaType` stops compiling there instead of being labelled an image. A `Record` cannot hold
  this union, one member is a template literal.
- `strict` lets through an `any` that a library's overload returns, and oxlint reads no types:
  `response.json()`, `JSON.parse`, and `Object.fromEntries` over pairs that lost their tuple type,
  which an array literal returned from a callback does. The constant that receives one carries
  its type: `attributes` in `markdown/page.tsx` is annotated as pairs, or `given` is `any` and
  spreads into the props of every node. To check a doubt, `const probe: number = <value>` must
  fail `bun x tsgo --noEmit`.
- `app.tsx` is the one file that reads the registry: it picks the renderer and hands the
  extensions' `actions` to the decision bar, which draws them before its own buttons. An action
  that follows the workspace reads `review` and loads its own state again at every change.
- A renderer that declares `comments: false` draws a document the reviewer answers in place, as
  a grill's transcript: `app.tsx` then draws no input method and no comments panel, unless the
  plan shows beside it. The unsent comments stay in the signals, and the bar keeps their count.
- The comments panel folds, on `commentsOpen` of `state.ts`: `comments.tsx` puts `folded` on the
  panel, whose CSS takes its width to zero, and draws `CommentsHandle`, the control `app.tsx`
  places on the panel's edge inside `.body`. A fold never unmounts the panel, since the general
  composer holds its half-typed text in a `useState`; a renderer with `comments: false` still
  does, as above. Folded, the panel is `inert`: zero width hides pixels, not focus. The handle's
  badge is the unfiltered total, the one count a folded panel still shows. The signal starts on
  `(max-width: 900px)`, the threshold `style.css` repeats in the media query where an open panel
  lays over the document.
- The page draws in every state, `drafting` included: `review.docs` is the working directory's
  renderable files, the plan at the head once there is one. A reader finds the plan by
  `planDoc`'s path, as `DocList` does, never by its place in `docs`. Comments are taken while
  `inReview` and while `drafting`, so `locked` names two states, not one, and Approve is drawn
  only where a version exists. `locked` reads `takesComments`, the domain's predicate the server
  holds a draft to as well. A renderer never reads `inputMethod`: it reads `activeMethod`, which
  is `null` on a locked page, so no composer opens there, and `addAnnotation` returns when
  locked, as `select` does while the editor is open. A comment nobody can send is a silent loss.
- `review.held` is what holds the review, or `null`. Held, Send feedback is disabled with the
  reason as its title, and every way to an approval goes through the warning popover, which
  says the approval ends what holds it. The bar prints the reason and never reads which
  extension gave it.
- `start` is the page's one way in, and its order is the rule: the saved draft into the signals,
  then the first load, then the saving effect, then the event stream. Nothing may `PUT` a draft
  before the restore, or every reload replaces the file with the page's empty state. After it,
  each change of the comments or of the edit is one write, sent in order; signals that change
  together change in one `batch`.
- An unsent edit is an `Edit`: a text with the version it edits. The stamp is taken when the
  editor opens, and `Editor` keeps that version and its base text for its whole session: a
  version that lands under an open editor must not restamp it. They travel as one `EditSession`,
  from `editing` to `Editor` to `finishEdit`, never unpacked: the base and the typed text are two
  strings, and swapped they compile, invert the line diff and record the old text as the edit. Every load settles the edit
  through `editOnLoad` (kept, landed, stale), a restored one included, which is why the restore
  comes before the first load. The editor never closes by itself and nothing Claude does clears
  the reviewer's comments: a stale edit is dropped with a banner, never silently, and Done on a
  version that moved keeps the editor open so the typing can be copied.
- One line diff, computed once: `planChanges` in `state.ts` compares the previous version with
  the text on screen, the bar prints its count, and the plan's renderer marks it while
  "Changes since" is on. On Done the same `lineDiff` shifts the plan's comments through
  `shiftAnnotations`, so a feedback only ever names lines of the text it is sent with.
- `EventSource` reconnects by itself, so the page polls nothing: `subscribe` reports `error`
  and `open`, `connection` keeps `up | down`, and the bar draws the lost-connection banner while
  `down`. A server revived on the same port and token clears it with no reload; past thirty
  seconds the banner names `/vellum:start`, the one way to a link that works.
- The server watches the working directory, so every file Claude writes reaches the page as a
  workspace event. A renderer loads its document through `docUrl`, whose query is the file's
  `modified`: a rewrite reloads that document alone, and nothing else remounts.
- What the reviewer waits on fails in the banner, through `error` of `state.ts`, as the core's
  own requests do: a write (`post` in `grill/page.tsx`) and a document's load (`sourceOf` in
  `markdown/page.tsx`). A load checks `response.ok` before it reads the body, or the server's
  error page is drawn as the document and takes comments. A read that only refreshes what is on
  screen may fail in silence, since the next workspace event reads again:
  `loadState` in `grill/page.tsx`.
- A `mermaid` block reaches the page as an empty `figure` carrying its lines and its source, and
  Mermaid fills it after the mount: the figure is the one place a renderer writes DOM that Preact
  does not own, and `data-source` is both what a comment on it quotes and what a late render
  checks before it writes. Its comment boxes the figure, since the SVG holds no text to highlight.
- A removed run is drawn as a `details.removed` that holds no text node: its label and its old
  source are attributes, drawn by CSS `content: attr()`. So it takes no selection, no pinpoint,
  and never enters the quote search of `anchoring.ts`. `markdown/changes.ts` chooses, purely,
  which block carries a mark and where a removed run goes: inside the `li` that follows it,
  before the whole table for a `tr`, never directly under `ul`, `ol`, `tbody` or `tr`.
- An HTML file is served with a sandboxed CSP, so the page cannot reach into it: `html/frame.ts`
  runs inside the mockup and owns the selection there, the page only sends it the method, the
  Ctrl state, the selectors already commented and the theme, four tokens resolved to sRGB since
  its shadow root reads none of the page's properties. `html/messages.ts` is the contract both
  sides import; every message crosses with the target `"*"` and each side checks `event.source`.
  That check proves the window, not the sender: `frameTag` in `http/routes.ts` adds `frame.js` to
  every HTML file served, so the mockup's own scripts, the model's, post from the same window.
  The page reads a frame's message through `parseFrameToPage` of `html/parse.ts` and drops what
  is not a whole `FrameToPage`; `frame.ts` casts, since the sender it verified is the page.
