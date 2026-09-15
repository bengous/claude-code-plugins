---
paths:
  - "ui/**"
  - "plugins/**"
---

# The page and its renderers

`ui/` is the Preact page: `api.ts` the client (token, routes, SSE), `state.ts` the store of
signals, `*.tsx` the components, `anchoring.ts` and `highlights.ts` the text selection.
`plugins/<kind>/` is one document kind: `server.ts` pure (candidates in, linked docs out) and
`ui.tsx` the renderer, registered in `plugins/server.ts` and `plugins/index.ts`. One bundle
is a browser's: `Bun.serve` builds it from `ui/index.html` at run time, no build step.

- `ui/` and `plugins/` never import `src/app` or `src/adapters`; they depend on
  `src/protocol.ts` only. `src/` never imports `ui/` beyond `index.html`. Held by
  `src/boundaries.test.ts`.
- Everything crossing `/api` is JSON and typed in `src/protocol.ts`; a new field lands there
  first.
- A new document kind is one folder with both halves and two registry lines, not a branch in
  an existing renderer.
