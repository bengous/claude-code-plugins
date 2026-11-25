Importing a GEDCOM file whose dates carry a time zone drops every person born after 1970: the tree shows 412 people where the file holds 1,203.

**Done when** an import keeps every person of the file. The counts and the dates shown are the contract; how the date is parsed is free.

| Situation | Today | Expected |
|---|---|---|
| `fixtures/tz.ged`, 1,203 people, dates with `+02:00` | 412 people | 1,203 people |
| a date `1985-03-02T10:00+02:00` | the person is missing | shown as 2 March 1985 |
| `fixtures/plain.ged`, dates with no time zone | 980 people | 980 people: no regression |

**Not this** the export to GEDCOM, the date format of the UI.

<details><summary>Author's leads</summary>

- The people missing are exactly those whose birth date has a time zone suffix.
- `bun run import fixtures/tz.ged` reproduces it in two seconds.
- Dates are parsed in one place, `parseDate` in `src/gedcom/date.ts`; the importer and the search index both call it.
- GEDCOM 7 allows the time zone suffix; GEDCOM 5.5.1 files have none, which is why the older fixtures pass.
- Possible direction: the parser already handles `Z`, so the suffix may only need the same path.

</details>

<sub>Written by Claude Opus 5.5</sub>
