---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/*.spec.ts"
  - "**/*.spec.tsx"
  - "scripts/affected.ts"
---

# Test tiers

A test file that starts a process (`git`, `bun`, a CLI, a fake `gh`) or a server is named `*.integration.test.ts`, or `*.integration.spec.ts` where its plugin names its suites `*.spec.ts`. `scripts/affected.ts` runs these apart from the unit tests, on half the cores (two on CI's runner) and a 20 s budget per test, and the unit tests in parallel on bun's 5 s: on a loaded CI runner a process's start has a long tail, which a unit test never pays. Such a file takes no `{ timeout }` of its own below that budget; a test that needs more says why beside it.
