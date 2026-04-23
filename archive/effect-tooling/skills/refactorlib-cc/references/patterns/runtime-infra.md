# Runtime Infrastructure Replacement Patterns

Patterns for infrastructure-layer code replaceable by Bun or Node.js built-in APIs.

## Bun-specific

| Handcrafted pattern | Grep for | Replacement |
|---|---|---|
| Manual TOML parsing | `parseTOML`, custom TOML parser | `Bun.TOML.parse(string)` |
| Custom `which` command lookup | `execSync("which ...)`, path traversal for binary lookup | `Bun.which(name)` |
| Manual file hashing | reading file + hashing in separate steps | `Bun.file(path).hash()` (if available in version) |
| Custom gzip/deflate | `import.*"node:zlib"` with manual streaming | `Bun.gzipSync` / `Bun.gunzipSync` |

## Verification technique for Bun APIs

Bun adds APIs faster than types catch up. Always verify:

1. **Runtime existence**: `bun -e "console.log(typeof Bun.theAPI)"` -- should print `function`
2. **Type existence**: grep `node_modules/@types/bun` or `node_modules/bun-types` for the type
3. **Output compatibility**: for deterministic APIs (hashing), run both implementations
   with identical input and compare output strings

If the API exists at runtime but not in types, it can still be used but may need a
`// @ts-expect-error` or a `.d.ts` augmentation. Flag this in the report.
