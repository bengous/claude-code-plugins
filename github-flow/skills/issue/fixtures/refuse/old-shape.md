## Problem

The import drops people born after 1970.

## Evidence

- `parseDate` in `src/gedcom/date.ts` ignores the time zone suffix.

## Hints

- Probably start at `parseDate`.

## Done when

- [ ] `fixtures/tz.ged` imports 1,203 people.
- [ ] `bun test` passes.

## Out of scope

The export.
