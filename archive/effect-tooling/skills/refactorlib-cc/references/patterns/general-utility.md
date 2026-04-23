# General Utility Replacement Patterns

These patterns apply to any JS/TS project. Search for custom code replaceable by native APIs.

| Handcrafted pattern | Grep for | Replacement |
|---|---|---|
| Custom left-pad / right-pad | `" ".repeat()` or loop-based padding | `padStart(n, char)` / `padEnd` |
| Custom date formatting | `getFullYear()`, `getMonth()`, `.padStart(2, "0")` | `Intl.DateTimeFormat` (keep if non-standard format like YYYYMMDD) |
| Custom relative time ("3h ago") | manual subtraction + unit thresholds | `Intl.RelativeTimeFormat` (native) |
| Custom duration parsing ("30m") | regex + switch on unit strings | Effect `Schema.transform` if Effect present; otherwise keep |
| Custom array grouping | `reduce` into `Map`/object by key | `Object.groupBy(array, fn)` (native ES2024) |
| Custom deep clone | `JSON.parse(JSON.stringify(...))`, recursive clone | `structuredClone(obj)` (native) |
| Custom UUID | manual byte manipulation, version/variant bits | `crypto.randomUUID()` (v4), `Bun.randomUUIDv7()` (v7), `Bun.randomUUIDv5()` (v5) |
| Custom `unique` / `dedupe` | `filter((v, i, a) => a.indexOf(v) === i)` | `[...new Set(array)]` or keep if deduping by key |

Utility functions at system boundaries (interop, hooks, scripts) are often intentionally
lightweight. Only flag utilities that run inside the application core where a heavier
library is already imported and available.
