# Module Testing Playbook for Hexagonal Architecture

Strategic guide for systematic test coverage with binary approach (100% or 0%)

---

## Core Principles

### The Foundation

**Test business logic completely. Skip everything else entirely.**

Your domain and application layers contain business value. The outer layers—composition, routing, framework integration—exist only to connect that value to the outside world.

### The Three Constraints

These aren't suggestions. They're invariants that ensure quality:

1. **Never modify production code while testing**
   - Testing validates existing behavior
   - Refactoring changes behavior
   - These are separate concerns
   - Keep them separate

2. **Aim for 100% coverage on what you test**
   - Coverage gaps reveal design issues
   - Unreachable code → dead code → remove it
   - Error paths you can't trigger → design smell
   - "Good enough" is a trap

3. **Test behavior, not implementation**
   - Public API only
   - Observable outcomes (Result.isOk/isErr)
   - Business rules (what happens, not how)
   - Implementation can change freely

---

## Architecture Pattern Recognition

### The Structure

```
src/modules/<domain>/
│
├── core/domain/                           ← TEST: 100%
│   ├── <Entity>.ts                        Business logic lives here
│   ├── <ValueObject>.ts                   Validation, invariants
│   ├── <StateMachine>.ts                  State transitions
│   ├── <DomainError>.ts                   Error types (optional)
│   └── events/                            ← SKIP: type definitions
│
├── application/
│   ├── use-cases/                         ← TEST: 100%
│   │   └── <Action>UseCase.ts             Orchestration logic
│   ├── policies/                          ← TEST: 100%
│   │   └── <BusinessRule>.ts              Validation rules
│   └── ports/                             ← CONTRACT TESTS (mandatory)
│       └── I<Port>.ts                     Interface definitions
│
├── infrastructure/
│   ├── adapters/                          ← INTEGRATION TESTS: 100%
│   │   └── <Adapter>.ts                   Real I/O (DB, filesystem)
│   ├── persistence/                       ← SKIP: schema definitions
│   │   └── schema.ts
│   └── mocks/                             ← SKIP: validated via contracts
│
├── composition/                            ← SKIP: just wiring (0%)
│   └── factories.ts
│
├── boundary/                               ← SKIP: E2E tested (0%)
│   └── actions.ts
│
└── ui/                                     ← SKIP: E2E tested (0%)
    └── components/
```

### What to Test (100% Coverage)

**Domain Layer:**
```typescript
// PATTERN: Entity with validation
export class Asset extends Entity<AssetProps> {
  static create(props: AssetProps): Result<Asset, Error> {
    // ✅ TEST: Every validation rule
    // ✅ TEST: Every invariant
    // ✅ TEST: Boundary conditions
  }

  updateStatus(status: Status): Result<void> {
    // ✅ TEST: State transitions
    // ✅ TEST: Business rules
    // ✅ TEST: Error conditions
  }

  get isProcessable(): boolean {
    // ✅ TEST: Computed logic
  }
}

// PATTERN: State machine (pure functions)
export function canTransition(from: Status, to: Status): boolean {
  // ✅ TEST: Every valid transition
  // ✅ TEST: Every invalid transition
  // Target: 100% (pure, critical)
}
```

**Application Layer:**
```typescript
// PATTERN: Use case with orchestration
export class CreateUserUseCase {
  async execute(data: UserData): Promise<Result<User>> {
    // ✅ TEST: Happy path
    // ✅ TEST: Each dependency failure
    // ✅ TEST: Validation errors
    // ✅ TEST: Business rule violations
    // ✅ TEST: Rollback scenarios
    // Mock ports, test orchestration
  }
}
```

**Infrastructure Layer:**
```typescript
// PATTERN: Repository (integration test)
export class DrizzleUserRepository implements IUserRepository {
  async findById(id: string): Promise<Result<User>> {
    // ✅ INTEGRATION TEST: With PGlite/real DB
    // ✅ TEST: CRUD operations
    // ✅ TEST: Complex queries
    // ✅ TEST: Error scenarios
    // ✅ TEST: Transactions
  }
}

// PATTERN: Contract test (mandatory for all ports)
describe.each([
  ['Production', new DrizzleUserRepository(db)],
  ['Mock', new MockUserRepository()],
])('%s implementation', (name, repo) => {
  // ✅ Same tests run against ALL implementations
  // ✅ Enforces identical behavior (LSP)
});
```

### What NOT to Test (0% Coverage)

```typescript
// ❌ SKIP: Type definitions
export type UserProps = { id: string; email: string };

// ❌ SKIP: Event definitions
export type UserCreated = DomainEvent & { type: 'user.created' };

// ❌ SKIP: Factory wiring
export function createUserService() {
  return new CreateUserUseCase(new DrizzleUserRepo());
}

// ❌ SKIP: Simple delegation
export async function getUser(id: string) {
  const service = createUserService();
  return service.execute(id);
}

// ❌ SKIP: Schema definitions
export const users = pgTable('users', { ... });
```

---

## Strategic Approach

### Phase 1: Analysis

**Map your architecture:**
1. Identify layers (domain, application, infrastructure, composition)
2. Recognize patterns (entities, use cases, repositories)
3. Distinguish business logic from plumbing

**Ask:** Where is the complexity? Where are the invariants? Where could bugs hide?

### Phase 2: Prioritization

**Test inside-out, layer by layer:**

1. **Domain (core/domain/)**: Pure logic, no dependencies - fastest to test, highest value
2. **Application (use-cases, policies)**: Orchestration, can mock ports - core business workflows
3. **Infrastructure (repositories, adapters)**: Integration tests needed - slower but proves it works

**SKIP:** Composition, boundary, UI (0% coverage)

Within each layer:
- Start simple (build momentum)
- Progress to complex (state machines, workflows)
- Finish with integrations

### Phase 3: Execution

**The Worktree Pattern:**
```bash
git worktree add ../module-tests -b test/module-coverage
# Work without touching main branch
# Review when complete
# Integrate via rebase (linear history)
```

**The Single Commit Principle:**

One logical unit = one commit:
- ✅ GOOD: "test(auth): achieve 100% coverage on domain layer"
- ❌ BAD: Multiple WIP commits

### Phase 4: Coverage Requirements

**For each pattern:**

- **Entities:** Valid creation, every validation rule, boundaries, edge cases, business methods, state transitions
- **State Machines:** Every valid/invalid transition (100%, non-negotiable)
- **Use Cases:** Happy path, dependency failures, validation failures, rollbacks
- **Repositories:** CRUD with real DB, complex queries, errors, transactions, contract tests

---

## Quality Invariants

### Coverage = 100% or Explain

Not "good enough." Not 90%. Either 100% or documented gap.

**If you can't reach 100%:**
1. Can you add a test? → Yes: Add it
2. Is the code reachable? → No: Delete it (dead code)
3. Is it defensive/safety code? → Document WHY it can't be tested

**Example of intentional gap:**
```typescript
// Platform-specific code on different OS
if (process.platform === 'win32') {
  // Document: "Windows-only, tested on Linux"
}
```

### No Production Changes = Absolute

**Rule:** Tests validate behavior. They don't change it.

**Why:**
- Testing ≠ refactoring (separate concerns)
- Coverage gaps reveal design issues (valuable feedback)
- Mixing creates confusion

**Exception:** None.

### Test Behavior, Not Structure

**Black-box testing:**

```typescript
// ✅ GOOD: Observable behavior
it('rejects empty email', () => {
  const result = User.create({ email: '' });
  expect(Result.isErr(result)).toBe(true);
  expect(result.error.code).toBe('VALIDATION_FAILED');
});

// ❌ BAD: Internal structure
it('sets email property', () => {
  expect(user.props.email).toBe('test@example.com');
});
```

---

## Agent Constraints Template

For autonomous test generation:

**Target:** [layer/files]
**Goal:** 100% coverage on reachable code

**Constraints:**
1. NEVER modify production code
2. Achieve 100% or document why not
3. Single commit when complete
4. All tests must pass

**Requirements:**
- Test all validation rules
- Test success + error paths
- Test edge cases
- Mock ports, not domain
- Use Result pattern correctly

**If <100% coverage:**
- Document each untested line
- Explain why untestable
- Propose fix or removal

**If unreachable code found:**
- Note it in coverage report
- Exclude from coverage calculation
- Recommend removal in separate PR
- Continue testing (not blocking)

---

## Success Criteria

Binary outcomes:
- ✅ Code has business logic → Test completely (100%)
- ✅ Code has no business logic → Skip entirely (0%)
- ❌ No middle ground

**Quality gates:**
- ✅ Business logic fully covered (100% on reachable code)
- ✅ Framework code skipped (0%)
- ✅ No production modifications
- ✅ Coverage gaps explained
- ✅ Behavior-focused tests
- ✅ Single atomic commit
- ✅ Contracts validated
- ✅ Unreachable code documented

---

## The Essence

Hexagonal architecture makes testing obvious:

- **Domain:** Pure logic → 100% achievable
- **Application:** Orchestration → 100% achievable
- **Infrastructure:** I/O → 100% achievable (integration tests)
- **Composition:** Wiring → 0% (skip)
- **Boundary:** Delegation → 0% (skip)

The constraints ensure quality:

- **No production changes** → Tests validate, don't modify
- **100% or explain** → No "good enough" thinking
- **Behavior focus** → Refactor-safe, long-term stable
- **Single commits** → Clear units, clean history

**The result:**

Confidence that business logic works correctly.

That's the goal. Everything else is noise.
