# Effect Infrastructure Replacement Patterns

Load this catalog when `effect`, `@effect/platform`, `@effect/cli`, `@effect/rpc`, or
`@effect/schema` are in the project's dependencies.

## Stream processing

| Handcrafted pattern | Grep for | Replacement |
|---|---|---|
| Manual Uint8Array chunk concat + TextDecoder | `TextDecoder`, `Uint8Array`, `runCollect` | `Stream.decodeText("utf-8")` piped to `Stream.mkString` |
| Line-by-line file parsing via `.split("\n")` | `split("\n")` in files importing Stream | `Stream.splitLines` |
| Manual stream-to-array collection | `Stream.runCollect` + `Chunk.toReadonlyArray` + manual transform | `Stream.run` with appropriate `Sink` |

## Retry and scheduling

| Handcrafted pattern | Grep for | Replacement |
|---|---|---|
| Custom retry loops with delay | `setTimeout.*retry`, `while.*attempt` | `Effect.retry` with `Schedule` |
| Manual exponential backoff | `Math.pow.*delay`, `backoff` | `Schedule.exponential` |
| Polling with interval | `setInterval`, custom poll loops | `Schedule.fixed` or `Schedule.spaced` |

## Error handling

| Handcrafted pattern | Grep for | Replacement |
|---|---|---|
| Custom Result/Success/Failure types | `type Result`, `type Success`, `type Failure` (not from effect) | `Effect.Effect<A, E>` or `Either.Either` |
| Manual try/catch with typed errors | `catch.*instanceof` in Effect service code | `Effect.catchTag` / `Effect.catchTags` |

## Validation

| Handcrafted pattern | Grep for | Replacement |
|---|---|---|
| Manual JSON schema validation | `typeof.*===.*"string"` chains for deep object validation | `Schema.decodeUnknown` with Effect Schema |
| Custom regex-based parsers | regex + switch/if for structured parsing in service code | `Schema.transform` with `Schema.filter` |
| Hand-rolled enum validation | `includes()` checks against string arrays | `Schema.Literal` union |

## Platform I/O (requires @effect/platform)

| Handcrafted pattern | Grep for | Replacement |
|---|---|---|
| Raw `fs.readFile`/`writeFile` inside Effect services | `import.*"node:fs"` in files also importing Effect | `FileSystem.FileSystem` from @effect/platform |
| Raw `child_process.exec/spawn` inside Effect services | `import.*"node:child_process"`, `Bun.spawn` in service code | `Command` from @effect/platform |
| Manual HTTP request building | `fetch(` in Effect service code | `HttpClient` from @effect/platform |
| Custom route matching | manual path regex in handlers | `HttpRouter` from @effect/platform |

## CLI (requires @effect/cli)

| Handcrafted pattern | Grep for | Replacement |
|---|---|---|
| Manual `process.argv` parsing | `process.argv.slice`, manual flag parsing | `@effect/cli` Command + Options |
| Custom help text generation | hand-built usage strings | `@effect/cli` auto-generated help |

## Configuration

| Handcrafted pattern | Grep for | Replacement |
|---|---|---|
| Direct `process.env` access in Effect services | `process.env` in files with Effect service code | `Effect.config` or `@effect/platform` SystemEnv |
| Manual config file loading + validation | readFile + JSON.parse + manual checks in services | `Config` provider with Schema validation |

## Concurrency

| Handcrafted pattern | Grep for | Replacement |
|---|---|---|
| Custom in-memory cache | `Map<string,` with TTL/expiry logic | `Effect.cachedWithTTL` or `Cache` |
| Manual mutex/locking in Effect code | `let locked = false`, promise-based locks | `Effect.Semaphore` |
| Custom queue implementations | array-based queue with shift/push | `Queue` from effect |

## Key distinction

Only flag code that runs **inside the Effect runtime** (services, layers, Effect.gen blocks).
Code that runs before Effect initializes (boot, hooks, lock files) is pre-runtime and should
be classified as KEEP. Check the import graph: if a file imports from `effect` and also uses
raw `fs` or `child_process`, it is a candidate. If it has no Effect imports, it is not.
