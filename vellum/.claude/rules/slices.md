---
paths:
  - "src/steps/**"
  - "src/formats/**"
  - "src/runtime/*/slices.ts"
  - "src/proof.ts"
  - "src/slices.spec.ts"
  - "src/workflow.spec.ts"
  - "src/table.spec.ts"
  - "src/workshop/plugs.ts"
  - "src/runtime/hooks/slice.ts"
  - "src/runtime/server/slice.ts"
  - "src/workshop/rows.ts"
---

# Slices

A folder of `src/steps/` or `src/formats/` that holds `contract.ts` is a slice: another folder imports that file
and nothing else of it, but for the registries, which take its halves, and for another slice, which
imports it with `import type`. `extensions.md` holds for a slice but where this page says otherwise.
What a contract says is checked, a type by `tsgo`, a half by `src/slices.spec.ts`, a row by
its test: no sentence in it is taken on trust.

To add one, in this order: declare it in `contract.ts`; run `bun x tsgo --noEmit`, which names what
each half and the model lack once you write their typed exports; then the three places outside the
folder, and no other:

- one line in each registry the slice has a half for (`slices.ts` of `src/runtime/hooks/`,
  `server/`, `page/`): `slices.spec.ts` names a missing one;
- each new tool's name in the matcher literal of `runtime/hooks/register.ts`, which the engine needs
  written out: `register.spec.ts` names a missing one;
- the page half's classes in `runtime/page/style.css`, prefixed with the slice's id: the page loads one
  stylesheet, and nothing names a class forgotten there.

The tests read the registries, so no suite lists the slices, their regions or their refusals: a
test that must change for a new slice is a test to fix, and saying so is part of the change. An
event's id is global across the core and every part: `tableOf` refuses one declared twice, naming
both owners, so a slice names its events after itself (`askQuestion`, `answerProposal`), never a
bare verb another part may take (`wait`, `pause` are the step's already).

- `contract.ts` holds the wire, the types crossing `/api/x/<id>/`, and one declaration,
  `export const SLICE = defineSlice({...})` (`workshop/plugs.ts`): the id, the events it owns with their
  senders and the fields each carries, the events of the others it hears, the hooks half's tools,
  listeners, posted routes and denied tools, each route as `get<Answer>()`, `getWith<Query,
  Answer>()` or `post<Body, Answer>()`, what opens it (`opened: payload<T>()`), what its Send part
  carries (`sends`), its page slots. What it leaves out it does not declare. Its plugs are
  `PlugsOf<typeof SLICE>`, which every half is typed by; then `RULES`.
- A slice's id, its events and its tools take the words of `vellum/CONTEXT.md`, the glossary: a
  word it lists under `_Avoid_` or gives another meaning is not a name. The folder takes the
  glossary's word for what the slice is; the id is the one `contract.ts` declares, which every
  half carries, and it does not follow the folder: it is on the wire, in `.review/` file names
  and in journals (`steps/proposal/` is `step`).
- An event heard is another slice's, `heard<ItsEvents["name"]>()`, typed by that slice's contract,
  each field possibly absent; or the core's, `core`, by a name the core has, fields untyped.
- `RULES` come from `rows(SLICE)`: `refuse(event, id, guard, status, reason)` on an event the slice
  owns or hears, and `whileHeld(event, status, reason)`. They read top to bottom per event: a row
  above the event's `whileHeld` row is judged before the hold, one below it after, an event with no
  `whileHeld` row passes a hold, and a row on another's event is judged after all of that one's. A
  row's id is what the journal records; its status is what its routes answer: 404, a name that is
  not there, or 409.
- A guard is a one-line function of the model that states the fields it reads
  (`(w, input: { readonly id: string }) => boolean`), composed with `allOf` and `anyOf`, which read
  every field their guards read. It reads `""` for a field its own event's input lacks; on a heard
  event it names its fields `string | undefined`, never optional, or an event that does not carry
  them is accepted. A guard declared in `naming({...})` holds on an input naming what is not there:
  a row built from it refuses the input, which no real caller meets and `refusedNow` never lists.
  Every other row refuses a state.
- Every row of every event reads as a sentence in `src/__snapshots__/table.spec.ts.snap`, in the
  order `verdictOf` judges them, with its owner, status, condition and reason as a caller meets it,
  a row no walked state ever makes the verdict included. A change of a row changes that file,
  rewritten with `bun test vellum/src/table.spec.ts --update-snapshots`; CI refuses to write it.
- An event's `by` lists its senders; with several, the route names one at `dispatch`.
- A word every runtime of the slice reads (a tool's name, a marker of the wire) lives in
  `parse.ts`, which the three load: `contract.ts`'s values are the server's.
- The halves are `export const hooks: HooksHalf<P>` in `hooks.ts`, `export const server:
  ServerHalf<P>` in `server.ts`, `export const page: PageHalf<P>` in `page.tsx`. The compiler
  refuses an undeclared tool, route or slot in the object literal; `slices.spec.ts` refuses it
  wherever it comes from, reading each half against `SLICE`. A tool is registered under its key,
  `mcp__vellum__<key>`. The registries call `engineExtension` and `serverExtension`, and take the
  page half as it is.
- A route answers `{ answer }`, `null` as 204, or `{ refused }`: the verdict `context.dispatch`
  answered, which carries its row's status (409 for a row the slice does not own), or a refusal of
  the route's own that no row judges (a 400 for a request the server's domain turns down after its
  parser let it through). 400 and 404 go in plain text and 409 as `{ error }`; a body or a query
  its parser (`BODIES` of `parse.ts`) refuses is a 400 before it runs. `context.dispatch` takes the
  slice's own events, with what each carries, and sends each as its declared sender.
  `context.start<ItsPlugs>(id, input)` opens another slice with what its contract says opens it.
- The hooks half posts through `context.post(route, body)` and gets a `Posted`: the route's declared
  answer, read by its parser in `ANSWERS` of `parse.ts` (`null` for a route that answers nothing),
  or the status, the text and the refusal's reason.
- A tool that waits for the reviewer hands `context.waitFor` a `Hold`: the mark it waits on, the
  route and body to post, how many attempts a failed post gets, and `settle`, what the call
  returns once the wait ends (`null` while it is open); `awaits: "own"` holds its slice's text
  entries for it. `answered` reads the mark back with `context.unanswered()` when the turn was cut
  before the wait ended. The server half answers that wait with `heldWait` of
  `runtime/server/slice.ts`, reading where it stands off its file with `waitedOn`, and its model
  keeps the wait with `waitAfter` and `waitOn` of `workshop/waits.ts`, the id under the
  region's `data.pending`.
- The pure model is named after the slice: its region, one transition per event (`Transitions`),
  the guards, `SAMPLES` per event (`Samples`), `REACTIONS` to the events it hears (`Reactions`), its
  segment and its line.
- `walk.ts` beside it exports `WALK` (`WalkOf` of `runtime/extension.ts`), what the proof of the table
  reads of the region: the empty region, what tells two regions apart, its bounds, the call a wait
  is for and the event that answers it, the slice's own invariants. The tests alone load it:
  `src/proof.ts` finds every `walk.ts` under `src/` by the part it names (`part`), and walks each part alone and each pair that meets
  (one hears the other's event, both hold, or one holds while the other refuses under a hold); a
  state that needs three parts at once is not walked. Every part with a workflow has one.
- Tests: the model's `*.spec.ts` holds one test per row of `RULES`, keyed by `RowKey`, so a row
  without its test does not compile; `hooks.test.ts` the kit's; `contract.spec.ts`, under
  `@ts-expect-error`, what this slice's plugs make a compile error that no other slice's suite
  already holds.
