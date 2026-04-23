# False-Positive Guardrails

Do NOT flag code in these categories. Each has a structural reason for being custom:

1. **Pre-runtime sync code** -- Lock files, boot paths, platform detection that must run
   before the Effect runtime initializes. These use `readFileSync`, `process.env`, `execSync`
   by necessity, not ignorance.

2. **Import barrier inlining** -- Code intentionally duplicated across layers to avoid
   cross-boundary imports. Look for comments like "inlined from X (import barrier)".

3. **Domain-specific logic** -- Custom markdown parsers, scoring models, prompt builders.
   These implement business rules that no library covers.

4. **Interop boundary guards** -- Lightweight type guards (`isRecord`, `safeJsonParse`) at
   boundaries where untyped data enters the system. Effect Schema is the right tool inside
   services, but at raw interop edges (hooks, JSONL parsing) a 3-line guard is simpler and
   has no dependencies.

5. **Test and script code** -- Utilities in `scripts/` or test helpers that exist for
   developer ergonomics. These are not production code.

6. **Anti-pattern with random input** -- If a deterministic API (like UUID v5) is called with
   random input, that defeats its purpose. Flag these as "simplify to random equivalent"
   rather than "replace with library X".
