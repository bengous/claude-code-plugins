# Claude Default Behaviors

Things Claude already does well without being told. Directives matching these patterns fail the deletion test: "Would removing this cause Claude to make mistakes?" — the answer is almost always no.

Use this reference during Phase 4 (Anti-Pattern Detection) to identify generic advice that wastes instruction budget.

## How to use this list

For each directive in the context file, check if it matches a pattern below. If it does, it is a candidate for REMOVE unless the directive adds **project-specific detail** that the generic behavior doesn't cover.

Example — generic (REMOVE): "Write tests for new features"
Example — specific (KEEP): "Write tests using Vitest with the test helper in tests/setup.ts"

The specific version tells Claude something it can't infer. The generic version tells it what it already does.

---

## Code Quality & Style

| Pattern | Why redundant | Keep if... |
|---------|---------------|------------|
| "Write clean/readable code" | Universal LLM behavior | Never — too vague to be actionable |
| "Use meaningful variable names" | Default behavior | Never |
| "Follow existing patterns in the codebase" | Claude pattern-matches from context window | You need a specific pattern called out |
| "Be consistent with the codebase" | Same as above | Specific consistency rule needed |
| "Use TypeScript strict mode" | Claude defaults to strict TS | Project uses unusual tsconfig settings |
| "Prefer functional programming" | Claude adapts to codebase style | Project mixes paradigms and you want to enforce one |
| "Use async/await over callbacks" | Default in modern JS/TS | Project has legacy callback APIs to avoid |
| "Destructure imports when possible" | Common default | Never — too minor to consume budget |
| "Use const over let" | Default behavior | Never |

## Error Handling & Safety

| Pattern | Why redundant | Keep if... |
|---------|---------------|------------|
| "Handle errors properly" | Default behavior | You have a specific error pattern (Effect.ts, Result types, custom error classes) |
| "Don't commit secrets/credentials" | System prompt already prevents this | Never |
| "Validate user input" | Default at system boundaries | You have a specific validation library/pattern |
| "Don't introduce security vulnerabilities" | System prompt covers OWASP top 10 | You have project-specific security constraints |
| "Use try/catch for error handling" | Default in JS/TS | You use a different error model |

## Testing

| Pattern | Why redundant | Keep if... |
|---------|---------------|------------|
| "Write tests for new features" | Claude does this contextually | You need specific framework/patterns (e.g., "use Vitest, not Jest") |
| "Write unit tests" | Default behavior | You need to specify test granularity or structure |
| "Test edge cases" | Default behavior | You have specific edge cases to always check |
| "Mock external dependencies" | Standard practice | You have a specific mock setup or factory pattern |

## Communication & Process

| Pattern | Why redundant | Keep if... |
|---------|---------------|------------|
| "Be concise" | System prompt says this | Never |
| "Explain your reasoning" | Depends on output style setting | Never — controlled by CLI settings |
| "Ask clarifying questions when uncertain" | Default behavior | Never |
| "Don't make assumptions" | Default behavior | You have a specific assumption-prone area |
| "Review code before committing" | System prompt covers this | Never |

## Code Organization

| Pattern | Why redundant | Keep if... |
|---------|---------------|------------|
| "Keep functions small" | General best practice | Never — too vague |
| "Don't repeat yourself (DRY)" | Default behavior | Never |
| "Separate concerns" | Default behavior | You need specific module boundary rules |
| "Use early returns" | Style preference Claude adapts to | Only if codebase is inconsistent and you want to enforce |

## Git & Workflow

| Pattern | Why redundant | Keep if... |
|---------|---------------|------------|
| "Write clear commit messages" | Default behavior | You have a specific format (conventional commits, issue refs) |
| "Don't push to main directly" | Standard practice | You have specific branch protection rules to document |
| "Review changes before committing" | System prompt covers this | Never |

---

## The Specificity Test

A directive earns its place when it contains **at least one** of:
- A file path (`tests/setup.ts`, `src/api/`)
- A tool/library name (`Vitest`, `Effect.ts`, `Biome`)
- A project-specific term (custom type names, domain concepts)
- A concrete command (`bun run test --bail`)
- A non-obvious constraint ("tests must run sequentially due to shared DB")

Without any of these, the directive is almost certainly generic advice that Claude already follows.
