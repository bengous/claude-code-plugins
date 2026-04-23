# Detection Patterns

## Sentinel patterns

| Pattern ID | Grep target | Sentinel | Default severity |
|---|---|---|---|
| `catchAll-succeed-null` | `catchAll(() => Effect.succeed(null` | null | error |
| `catchAll-succeed-empty-array` | `catchAll(() => Effect.succeed([]` | empty-array | warning |
| `catchAll-succeed-false` | `catchAll(() => Effect.succeed(false` | false | warning |
| `catchAll-void` | `catchAll(() => Effect.void` | void | warning |
| `catchAll-effect-void` | `catchAll(() => Effect.succeed(undefined` | void | warning |
| `effect-ignore` | `Effect.ignore` | void | error |

## Severity escalation

Default severity from the table above is the floor. Escalate based on context:

| Condition | Severity |
|---|---|
| Exported function or public service method | error |
| Internal function, no suppression annotation | warning |
| Has `etch-best-effort:` annotation (or project-configured marker) | info |
| Test file, mock, or fixture | skip |

## Why each sentinel is dangerous

**null** -- Most dangerous. Forces callers to handle `T | null` without knowing why null.
"File not found" and "disk full" both become `null`. Always error severity.

**empty-array** -- Hides "could not read directory" behind "directory is empty".
Medium risk because callers often treat both cases the same (iterate over nothing).

**false** -- Hides "could not check" behind "does not exist".
Common in `fs.exists()` wrappers. Medium risk but can mask permission errors.

**void** -- Fire-and-forget. The operation's success or failure is invisible.
Acceptable only for truly optional operations (observability sinks, cleanup).

## What the scanner does NOT flag

- `catchTag("SpecificError", ...)` -- targeted recovery, not blanket swallowing
- `catchAll` that re-emits via `Effect.fail(new DifferentError(...))` -- error transformation
- `catchAll` inside `Effect.ensuring` / finalizer blocks -- cleanup is legitimately best-effort
- `mapError(...)` -- error transformation, not swallowing
