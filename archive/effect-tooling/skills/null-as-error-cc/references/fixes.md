# Fix Strategies

Three strategies for replacing silent error swallowing. Choose based on the decision tree below.

## Decision tree

```
Does the operation have a "normal absence" case?
(e.g., file not existing on first day, directory not yet created)
│
├─ YES ─→ Is the absence distinguishable from a real failure?
│         │
│         ├─ YES ─→ Strategy 2: Named ADT
│         │         (source_missing vs copy_failed are different things)
│         │
│         └─ NO ──→ Strategy 1: Propagate
│                   (catch the specific not-found, let everything else bubble)
│
└─ NO ──→ Is the operation truly optional?
          (observability, enrichment, cleanup -- not on the critical path)
          │
          ├─ YES ─→ Strategy 3: Best-effort with logging
          │         (catch + warn via observability + annotate)
          │
          └─ NO ──→ Strategy 1: Propagate
                    (the caller needs to know it failed)
```

## Strategy 1: Propagate errors

Let the error bubble up. The caller decides what to do.

```typescript
// Before
fs.copy(src, target).pipe(Effect.catchAll(() => Effect.succeed(null)))

// After
fs.copy(src, target).pipe(
  Effect.mapError((cause) =>
    new LogError({ kind: "write", message: "Failed to copy", cause })
  )
)
```

**When**: No "normal absence" case. The operation should either succeed or fail visibly.

**Key principle**: The function that wraps an error should add context (what was being
attempted), not swallow it. `mapError` preserves the error in the typed channel.

## Strategy 2: Named ADT in the success channel

Distinguish "nothing to do" from "something went wrong" with a domain-typed result.

```typescript
type SnapshotResult =
  | { readonly kind: "created"; readonly path: string }
  | { readonly kind: "source_missing" };

// Store: honest about what happened
function snapshot(day, runId): Effect<SnapshotResult, LogError> {
  // Check existence, return source_missing if absent
  // Copy with mapError for real failures
  // Return { kind: "created", path } on success
}

// Caller: decides what to do with the result
const result = yield* dailyLog.snapshot(day, runId);
// source_missing is normal (first day), no action needed
// LogError means something broke -- caller decides policy
```

**When**: The function has a "normal absence" case that is semantically different from failure.

**Naming convention**: Use the project's discriminant convention (`kind` for domain types,
`_tag` for kernel types in etch). Name the variants after domain concepts, not generic
containers (`source_missing` not `none`).

**TOCTOU defense**: When checking existence then acting, also handle not-found errors from
the action itself (file can disappear between check and action). Normalize that specific
error to the "missing" variant, let other errors propagate.

## Strategy 3: Best-effort with logging

The operation is optional, but failures should be visible through observability.

```typescript
// The store propagates errors honestly
function snapshot(day, runId): Effect<SnapshotResult, LogError> { ... }

// The caller owns the policy
yield* dailyLog.snapshot(day, runId).pipe(
  Effect.catchAll((error) =>
    observability.warn("snapshot.failed", error.message, {
      day, runId, kind: error.kind,
    })
  ),
);
```

**When**: The operation is genuinely optional (observability sinks, enrichment, cleanup).

**Key principles**:
- The function doing the I/O (store) propagates errors honestly
- The caller with observability access (applier, coordinator) catches and logs
- Add a suppression annotation (`// etch-best-effort: <reason>`) so the scanner
  marks it as intentional
- Never fabricate a fake success value in the catchAll -- just log and continue

## Anti-patterns to avoid

1. **Fake ADT in catchAll**: `catchAll(() => Effect.succeed({ kind: "source_missing" }))` --
   this lies about what happened. A disk-full error is not "source missing".

2. **Either in the success channel**: `Effect<Either<A, SkipReason>, never>` --
   reimplements Effect's error channel. Use `Effect<A, E>` instead.

3. **Blanket catchAll on exported functions**: Makes the error channel lie (`E = never`
   when the operation can clearly fail). Callers build on the lie.
