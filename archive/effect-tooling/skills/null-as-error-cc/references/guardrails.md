# Guardrails: False Positive Prevention

## Always skip

1. **Test files and mocks** -- `*.test.ts`, `*.spec.ts`, `testing/`, `__tests__/`.
   Mocks return sentinels by design. The scanner filters these automatically.

2. **Observability sinks** -- Files in `observability/` or `monitoring/` directories.
   Observability infrastructure must never block the main pipeline. Self-protecting
   best-effort is by design, not a bug.

## Skip when annotated

3. **Suppressed with intent marker** -- Lines with `etch-best-effort: <reason>` (or the
   project's configured marker). The developer made a conscious decision and documented why.
   Report as `[SUPPRESSED]`, not `[ERROR]`.

## Investigate before flagging

4. **`Effect.ignore` in finalizers** -- `Effect.ensuring(cleanup.pipe(Effect.ignore))` is
   legitimate. Finalizer cleanup should not fail the parent effect. Check whether `ignore`
   appears inside `ensuring`, `onInterrupt`, `addFinalizer`, or `acquireRelease` release.

5. **`catchAll` that re-emits** -- If the catchAll body contains `Effect.fail(...)` or
   `new SomeError(...)`, it is transforming the error, not swallowing it. Example:
   ```typescript
   .pipe(Effect.catchAll((e) => new DomainError({ cause: e })))
   ```
   This is error mapping, not null-as-error.

6. **Platform probing** -- `fs.exists()` wrapped with `catchAll(() => Effect.succeed(false))`
   is the standard pattern for "does this path exist, and I don't care about permission
   errors at this point". Common in scheduler installation, config migration, bootstrap.
   Flag as `[WARNING]` not `[ERROR]` unless the function is exported.

7. **Collector enrichment** -- In data collection pipelines, individual source failures
   should not abort the entire collection. `catchAll` with logging is appropriate here.
   Check whether the surrounding function is a collector or enrichment step.

## Context that changes severity

| Context | Effect on severity |
|---|---|
| Function is exported / on a public service interface | Escalate to error |
| Function is internal, single caller | Keep as warning |
| Caller already handles the sentinel value meaningfully | Reduce to info |
| File has `.etch-rules.json` with `allow-contract` decision | Reduce to info |
| `catchAll` is the last operation before return | Higher risk (result leaks) |
| `catchAll` is mid-pipeline with further operations | Lower risk (local recovery) |
