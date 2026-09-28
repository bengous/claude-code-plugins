---
paths:
  - "src/extensions/step/**"
  - "src/core/plugs.ts"
  - "src/core/engine/slice.ts"
  - "src/core/server/slice.ts"
  - "src/core/server/domain/rows.ts"
---

# Slices

A slice is an extension folder read through one file, `contract.ts`: another folder imports it and
nothing else of the folder, but for the registries, which take its halves. `step` is the one slice;
the rest of `extensions.md` holds for it but where this page says otherwise. What a contract says
is checked, a type by `tsgo`, a row by its test: no sentence in it is taken on trust.

- `contract.ts` holds the wire, the types crossing `/api/x/<id>/`; `EVENTS`, each event the slice
  owns with its sender and the fields it carries (`events` of `core/server/domain/rows.ts`); the
  plugs, `<Name>Plugs`, a `Plugs` of `core/plugs.ts`: the id, the tools and the engine events the
  hooks half takes, each route as `GET <name>` or `POST <name>` with its body and its answer, the
  events, the page slots; and `RULES`, rows built by `rows(EVENTS)` from named guards.
- `RULES` reads top to bottom per event: a row above the event's `whileHeld` row is judged before
  the hold, one below it after, and an event with no `whileHeld` row passes a hold. `refuse` turns
  down a state a caller meets; `refuseInput` an input naming what is not there, which `refusedNow`
  never lists. A row's id is what the journal records. Each row, the hold's included, declares the
  status its routes answer the refusal with: 404, a name that is not there, or 409.
- A guard is a one-line function of the model that states the fields it reads
  (`(w, input: { readonly id: string }) => boolean`), composed with `allOf` and `anyOf`: a row
  takes it only on an event that carries those fields. It reads `""` for a field the input lacks.
- The contract's values import the domain, so the hooks module and the page read it with
  `import type`; `boundaries.spec.ts` follows everything `hooks.ts` and `page.tsx` load.
- The halves are `export const hooks: HooksHalf<P>` in `hooks.ts`, `export const server:
  ServerHalf<P>` in `server.ts`, `export const page: PageHalf<P>` in `page.tsx`, each one object
  literal: an undeclared tool or route in a variable passes the compiler. A tool is registered under
  its key, `mcp__vellum__<key>`, which the matcher literal of `core/engine/register.ts` names too
  (`register.spec.ts`). The registries call `engineExtension` and `serverExtension`, and take the
  page half as it is.
- A route answers `{ answer }`, `null` as 204, or `{ refused }`: the verdict `context.dispatch`
  answered, which carries its row's status (409 for a row the slice does not own, the core's or
  another slice's), or a refusal of the route's own that no row judges. 404 goes in plain text and
  409 as `{ error }`, as the wire held before slices; a body its parser (`BODIES` of `parse.ts`)
  refuses is a 400 before it runs. `context.dispatch(event, input)` takes the slice's own events,
  with what each carries, and sends each as its declared sender.
- The pure model is named after the slice (`proposal.ts`): its region, one transition per event
  (`Transitions`), the guards, `SAMPLES` per event (`Samples`), its reaction to the others' events,
  its segment and its line.
- Tests: `contract.spec.ts` holds, under `@ts-expect-error`, what the plugs make a compile error;
  the model's `*.spec.ts` one test per row of `RULES`, keyed by `RowKey`, so a row without its test
  does not compile; `hooks.test.ts` the kit's.

To add a step: write its `contract.ts` first; `bun x tsgo --noEmit` then names what each half and
the model lack; write them; one line in each registry the slice has a half for; its rows' tests.
