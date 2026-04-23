# Runtime Utility Replacement Patterns

Patterns for utility-layer code replaceable by Bun or Node.js built-in APIs.

## Bun-specific

| Handcrafted pattern | Grep for | Replacement |
|---|---|---|
| Custom UUID v5 implementation (SHA-1 + namespace bytes) | `CryptoHasher("sha1")`, `parseUuid`, manual version/variant bit manipulation | `Bun.randomUUIDv5(name, namespace)` -- identical RFC 4122 output |
| Custom hash-to-hex utilities | `CryptoHasher`, `.digest("hex")` wrapped in helpers | Direct `new Bun.CryptoHasher(algo).update(input).digest("hex")` -- no wrapper needed if used once |
| `crypto.randomUUID()` for unique IDs | `crypto.randomUUID` | `Bun.randomUUIDv7()` -- time-sortable, monotonic, better for database indexing |

## Node.js built-ins (also available in Bun)

| Handcrafted pattern | Grep for | Replacement |
|---|---|---|
| Manual base64 encode/decode | custom base64 functions, char code manipulation | `Buffer.from(str).toString("base64")` / `atob()` / `btoa()` |
| Custom URL parsing | regex-based URL extraction | `new URL(input)` with try/catch |
| Manual path joining with string concat | `+ "/" +`, template literal path building | `path.join()` or `path.resolve()` |
| Custom deep clone | recursive clone functions, `JSON.parse(JSON.stringify(...))` | `structuredClone(obj)` (native since Node 17+, all Bun versions) |
| Custom event emitter | hand-rolled pub/sub with arrays of callbacks | `EventEmitter` from `node:events` |

## Anti-patterns to flag (not replacements, but simplifications)

| Pattern | Grep for | Issue |
|---|---|---|
| Deterministic API with random input | `uuidV5.*randomUUID`, `uuidV5.*randomUUIDv7` | UUID v5 is for deterministic IDs. If input contains randomness, use `randomUUIDv7()` directly. |
| Hash for uniqueness only | `shortHash.*randomUUID` | If the hash input includes randomness and the output only needs uniqueness, the random UUID alone suffices. |
