---
paths:
  - "src/extensions/step/**"
  - "src/extensions/grill/**"
  - "src/table.spec.ts"
  - "src/core/plugs.ts"
  - "src/core/engine/slice.ts"
  - "src/core/server/slice.ts"
  - "src/core/server/domain/rows.ts"
---

# Slices

A slice is an extension folder read through one file, `contract.ts`: another folder imports it and
nothing else of the folder, but for the registries, which take its halves, and for another slice,
which imports it with `import type`. `step` and `grill` are slices; the rest of `extensions.md`
holds for them but where this page says otherwise. What a contract says
is checked, a type by `tsgo`, a row by its test: no sentence in it is taken on trust.

- `contract.ts` holds the wire, the types crossing `/api/x/<id>/`; `EVENTS`, each event the slice
  owns with its sender and the fields it carries (`events` of `core/server/domain/rows.ts`); the
  plugs, `<Name>Plugs`, a `Plugs` of `core/plugs.ts`: the id, the tools, the engine events and the
  routes (`posts`) the hooks half takes, each route as `GET <name>` or `POST <name>` with its body
  and its answer, the events, the page slots; and `RULES`, rows built by `rows(EVENTS)` from named
  guards.
- `RULES` reads top to bottom per event: a row above the event's `whileHeld` row is judged before
  the hold, one below it after, and an event with no `whileHeld` row passes a hold. `refuse` turns
  down a state a caller meets; `refuseInput` an input naming what is not there, which `refusedNow`
  never lists. A row's id is what the journal records. Each row, the hold's included, declares the
  status its routes answer the refusal with: 404, a name that is not there, or 409.
- Every row of every event, the core's and every extension's, reads as a sentence in
  `src/__snapshots__/table.spec.ts.snap`, in the order `verdictOf` judges them, with its
  owner, status, condition and reason as a caller meets it: a row of another slice on this slice's
  event shows there, and so does a row no sample state ever makes the verdict. A change of a row
  changes that file, rewritten with `bun test vellum/src/table.spec.ts
  --update-snapshots`; CI refuses to write it.
- A guard is a one-line function of the model that states the fields it reads
  (`(w, input: { readonly id: string }) => boolean`), composed with `allOf` and `anyOf`, which
  read every field their guards read: a row takes it only on an event that carries those fields.
  It reads `""` for a field the input lacks. A guard on an event the slice hears names its
  fields `string | undefined` (`{ readonly move: string | undefined }`), never optional: an
  optional field is accepted from an event that does not carry it.
- An event's `by` lists its senders; with several (`endGrill`), the route names one at `dispatch`.
- `hears` names the events of the others a slice judges or reacts to: another slice's, typed by
  its contract (`Pick<StepEvents, "answerProposal">`), or the core's by name, fields untyped
  (`CoreHeard`), each field possibly absent (`Read`). `refuseHeard`/`refuseInputHeard` put a row
  on such an event, judged after every row its owner declares on it; `REACTIONS` answer them, one
  per event heard.
- `opened` names what another slice hands `start` to open this one (the grill's `{ subject }`):
  the half parses it (`opened`) and says what Claude is told (`start`); the caller writes
  `context.start<GrillPlugs>("grill", { subject })`, and without the type argument no id
  compiles. `sends` types what the half's `part` of the bar's Send carries to its reaction to
  `send`, which the core serializes. `hooks.denies` names the engine's tools the hooks half
  refuses while live (`refuses`). Each is `never` in a contract that has none, and its half's
  field is then refused.
- A word every runtime of the slice reads (a tool's name, a marker of the wire) lives in
  `parse.ts`, which the three load: `contract.ts`'s values are the server's.
- The halves are `export const hooks: HooksHalf<P>` in `hooks.ts`, `export const server:
  ServerHalf<P>` in `server.ts`, `export const page: PageHalf<P>` in `page.tsx`, each one object
  literal: an undeclared tool or route in a variable passes the compiler. A tool is registered under
  its key, `mcp__vellum__<key>`, which the matcher literal of `core/engine/register.ts` names too
  (`register.spec.ts`). The registries call `engineExtension` and `serverExtension`, and take the
  page half as it is.
- A route answers `{ answer }`, `null` as 204, or `{ refused }`: the verdict `context.dispatch`
  answered, which carries its row's status (409 for a row the slice does not own, the core's or
  another slice's), or a refusal of the route's own that no row judges (a 400 for a request the
  server's domain turns down after its parser let it through, as a path outside the project).
  400 and 404 go in plain text and 409 as `{ error }`, as the wire held before slices; a POST's
  body or a GET's query its parser (`BODIES` of `parse.ts`) refuses is a 400 before it runs.
  `context.dispatch(event, input)` takes the slice's own events, with what each carries, and sends
  each as its declared sender.
- The hooks half posts through `context.post(route, body)`, a route of its `posts` with its body,
  and gets a `Posted`: the route's declared answer, read by its parser in `ANSWERS` of `parse.ts`
  (`null` for a route that answers nothing), or the status, the text and the refusal's reason.
- The pure model is named after the slice (`proposal.ts`, `grill.ts`): its region, one transition
  per event (`Transitions`), the guards, `SAMPLES` per event (`Samples`), `REACTIONS` to the
  events it hears (`Reactions`), its segment and its line.
- Tests: `contract.spec.ts` holds, under `@ts-expect-error`, what the plugs make a compile error;
  the model's `*.spec.ts` one test per row of `RULES`, keyed by `RowKey`, so a row without its test
  does not compile; `hooks.test.ts` the kit's.

To add a step: write its `contract.ts` first; `bun x tsgo --noEmit` then names what each half and
the model lack; write them; one line in each registry the slice has a half for; its rows' tests.
