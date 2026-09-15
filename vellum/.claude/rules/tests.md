---
paths:
  - "**/*.test.ts"
---

# Tests

- One behaviour per test, under fifteen lines, data in view: helpers hide the plumbing; the
  version, the path, the text the case turns on stay in the test.
- Before the code of a slice, its tests are listed one line each and agreed, written first,
  seen failing for the right reason.
- Fakes at the ports, nothing else faked: the engine's `$` answered from memory in
  `hooks/register.test.ts`; the server's file system is a temp directory through the real
  adapter; `adapters/http` starts the server on port 0. No module mocking, no spy on an
  internal call.
- `src/boundaries.test.ts` holds the dependency direction; an import that fails it is in the
  wrong layer, not a test to loosen.
