Importing a GEDCOM file whose dates carry a time zone drops every person born after 1970.

**Done when** an import keeps every person. The counts are the contract; the parser is free.

| Situation | Expected |
|---|---|
| `fixtures/tz.ged` | 1,203 people |
| `fixtures/plain.ged` | 980 people: no regression |

<details><summary>Author's leads</summary>

- Fix: strip the suffix in `parseDate`.
- Possible direction: a date library.
1. Change `parseDate`.
2. Add a test.

</details>

<sub>Written by Claude Opus 5.5</sub>
