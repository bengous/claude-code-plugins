# Hexagonal Architecture Testing Guide

Comprehensive reference for testing hexagonal architecture layers systematically.

**Quick start:** `/test-layer <module> <layer>`

---

## Table of Contents

1. [Layer Testing Strategies](#layer-testing-strategies)
2. [Test Patterns by Layer](#test-patterns-by-layer)
3. [Critical Testing Rules](#critical-testing-rules)
4. [Common Pitfalls](#common-pitfalls)
5. [Example Execution Flow](#example-execution-flow)

---

## Layer Testing Strategies

### Core/Domain Layer

**Philosophy:** Test business rules and invariants

**Coverage Target:** 90-100%

**What to Test:**
- Entities (especially `.create()` factory methods)
- Value objects (validation logic)
- State machines (transition rules)
- Domain services (business logic)

**What to Skip:**
- Events (no logic)
- Type definitions (no behavior)
- Re-exports (no logic)
- Enums without validation

**Testing Approach:**
- Pure unit tests (no mocks)
- Test validation rules exhaustively
- Test state transitions
- Test business invariants
- Test Result<T,E> error cases

**Example Coverage:**
```
PhotoshootEntity.create()        ✅ Test all validation rules
PhotoshootStateMachine           ✅ Test all state transitions
PhotoshootStatus (enum)          ❌ Skip (no logic)
PhotoshootCreatedEvent           ❌ Skip (no behavior)
```

---

### Application Layer

**Philosophy:** Test orchestration and business workflows

**Coverage Target:** 80-90%

**What to Test:**
- Use cases (orchestration logic)
- Policies (business rules)
- Application services

**What to Skip:**
- Port interfaces (test implementations instead)
- Simple DTOs (no behavior)
- Event handlers (test in integration tests)

**Testing Approach:**
- Mock all ports (repository, services, etc.)
- Test business logic flows
- Test error handling paths
- **CRITICAL:** Contract tests for all port implementations

**Example Coverage:**
```
CreatePhotoshootUseCase          ✅ Test orchestration logic (mock ports)
IPhotoshootRepository (port)     ❌ Skip (interface has no behavior)
PhotoshootRepository (impl)      ✅ Test via contract tests
PhotoshootPolicy                 ✅ Test business rules
```

---

### Infrastructure Layer

**Philosophy:** Test I/O and external integrations

**Coverage Target:** 60-80%

**What to Test:**
- Repositories (database operations)
- Adapters with business logic
- External service clients
- Data mappers with transformation logic

**What to Skip:**
- Schema definitions (no behavior)
- Simple wrappers (thin delegation)
- Existing mocks (they're test helpers)

**Testing Approach:**
- Integration tests with PGlite
- Test real I/O operations
- Mock external APIs only
- Test error cases (network, DB failures)

**Example Coverage:**
```
PhotoshootRepository             ✅ Integration test with PGlite
PhotoshootSchema (Drizzle)       ❌ Skip (schema definition)
MockPhotoshootRepository         ❌ Skip (test helper)
S3StorageAdapter                 ✅ Integration test or mock S3
```

---

### Boundary Layer

**Philosophy:** Prefer E2E tests over unit tests

**Coverage Target:** 10-20%

**What to Test:**
- ONLY if transformation/validation logic exists
- Complex request/response mapping
- Input sanitization logic

**What to Skip:**
- Simple delegation to application layer
- Framework boilerplate
- Routing configuration

**Testing Approach:**
- E2E tests preferred (test full request cycle)
- If unit testing: test transformation logic only
- Integration tests with real HTTP requests

**Example Coverage:**
```
PhotoshootController             ❌ Skip (simple delegation) - E2E test instead
CreatePhotoshootDTO (validation) ✅ Test if complex validation exists
PhotoshootResponseMapper         ✅ Test if transformation logic exists
```

---

## Test Patterns by Layer

### Core/Domain: Entity Validation Tests

```typescript
describe('PhotoshootEntity.create()', () => {
  describe('validation', () => {
    it('requires title', () => {
      const result = PhotoshootEntity.create({
        title: '',
        date: validDate
      });

      expect(Result.isErr(result)).toBe(true);
      if (Result.isErr(result)) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
        expect(result.error.message).toContain('title');
      }
    });

    it('requires valid date', () => {
      const result = PhotoshootEntity.create({
        title: 'Valid',
        date: 'invalid-date'
      });

      expect(Result.isErr(result)).toBe(true);
    });

    it('creates entity with valid data', () => {
      const result = PhotoshootEntity.create(validData);

      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        expect(result.value.title).toBe(validData.title);
      }
    });
  });

  describe('business rules', () => {
    it('enforces date must be in future', () => {
      const pastDate = new Date('2020-01-01');
      const result = PhotoshootEntity.create({
        title: 'Valid',
        date: pastDate
      });

      expect(Result.isErr(result)).toBe(true);
    });
  });
});
```

**Key patterns:**
- Test all validation rules
- Test all business invariants
- Use `Result.isOk()` / `Result.isErr()` type guards
- Narrow type in `if` block before accessing `.value` / `.error`

---

### Core/Domain: State Machine Tests

```typescript
describe('PhotoshootStateMachine', () => {
  it('allows DRAFT -> CONFIRMED transition', () => {
    const result = PhotoshootStateMachine.transition({
      from: PhotoshootStatus.DRAFT,
      to: PhotoshootStatus.CONFIRMED,
      context: validContext
    });

    expect(Result.isOk(result)).toBe(true);
  });

  it('blocks COMPLETED -> DRAFT transition', () => {
    const result = PhotoshootStateMachine.transition({
      from: PhotoshootStatus.COMPLETED,
      to: PhotoshootStatus.DRAFT,
      context: validContext
    });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.code).toBe('INVALID_TRANSITION');
    }
  });

  it('requires payment for CONFIRMED -> COMPLETED', () => {
    const result = PhotoshootStateMachine.transition({
      from: PhotoshootStatus.CONFIRMED,
      to: PhotoshootStatus.COMPLETED,
      context: { ...validContext, paymentReceived: false }
    });

    expect(Result.isErr(result)).toBe(true);
  });
});
```

---

### Application: Use Case Tests

```typescript
describe('CreatePhotoshootUseCase', () => {
  let useCase: CreatePhotoshootUseCase;
  let mockRepository: MockType<IPhotoshootRepository>;
  let mockEventBus: MockType<IEventBus>;

  beforeEach(() => {
    mockRepository = {
      save: vi.fn(),
      findById: vi.fn()
    };
    mockEventBus = {
      publish: vi.fn()
    };

    useCase = new CreatePhotoshootUseCase(
      mockRepository,
      mockEventBus
    );
  });

  describe('happy path', () => {
    it('creates photoshoot and publishes event', async () => {
      const input = { title: 'Test', date: validDate };

      mockRepository.save.mockResolvedValue(
        Result.ok(savedEntity)
      );

      const result = await useCase.execute(input);

      expect(Result.isOk(result)).toBe(true);
      expect(mockRepository.save).toHaveBeenCalledTimes(1);
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'PhotoshootCreated'
        })
      );
    });
  });

  describe('error cases', () => {
    it('handles repository failure', async () => {
      mockRepository.save.mockResolvedValue(
        Result.err({ code: 'DB_ERROR', message: 'Failed' })
      );

      const result = await useCase.execute(validInput);

      expect(Result.isErr(result)).toBe(true);
      expect(mockEventBus.publish).not.toHaveBeenCalled();
    });

    it('handles invalid input', async () => {
      const result = await useCase.execute({ title: '' });

      expect(Result.isErr(result)).toBe(true);
      expect(mockRepository.save).not.toHaveBeenCalled();
    });
  });
});
```

**Key patterns:**
- Mock all ports (dependencies)
- Test orchestration logic, not port implementations
- Test happy path + all error paths
- Verify interactions (called, not called, call order)

---

### Application: Contract Tests

```typescript
describe.each([
  ['Real Implementation', () => new PhotoshootRepository(db)],
  ['Mock Implementation', () => new MockPhotoshootRepository()]
])('IPhotoshootRepository: %s', (name, createAdapter) => {
  let adapter: IPhotoshootRepository;

  beforeEach(async () => {
    adapter = createAdapter();
  });

  it('follows save contract', async () => {
    const entity = PhotoshootEntity.create(validData);
    if (Result.isErr(entity)) throw new Error('Setup failed');

    const result = await adapter.save(entity.value);

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.id).toBeDefined();
      expect(result.value.title).toBe(entity.value.title);
    }
  });

  it('follows findById contract', async () => {
    const result = await adapter.findById('test-id');

    // Result can be Ok(entity) or Ok(null) - both valid
    expect(Result.isOk(result)).toBe(true);
  });

  it('handles errors gracefully', async () => {
    // Force error condition (implementation-specific)
    const result = await adapter.save(invalidEntity);

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.code).toBeDefined();
    }
  });
});
```

**Why contract tests:**
- Ensures mocks and real implementations honor same contract
- Catches divergence between mock and production code
- Provides confidence in test accuracy

---

### Infrastructure: Integration Tests with PGlite

```typescript
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

describe('PhotoshootRepository (integration)', () => {
  let db: PGliteDatabase;
  let repository: PhotoshootRepository;

  beforeEach(async () => {
    // Create in-memory test database
    const client = new PGlite();
    db = drizzle(client);

    // Run migrations
    await migrate(db, { migrationsFolder: './drizzle' });

    repository = new PhotoshootRepository(db);
  });

  afterEach(async () => {
    await db.$client.close();
  });

  describe('save', () => {
    it('persists entity to database', async () => {
      const entity = PhotoshootEntity.create(validData);
      if (Result.isErr(entity)) throw new Error('Setup failed');

      const result = await repository.save(entity.value);

      expect(Result.isOk(result)).toBe(true);

      // Verify in database
      if (Result.isOk(result)) {
        const rows = await db
          .select()
          .from(photoshoots)
          .where(eq(photoshoots.id, result.value.id));

        expect(rows).toHaveLength(1);
        expect(rows[0].title).toBe(validData.title);
      }
    });

    it('handles unique constraint violation', async () => {
      const entity = PhotoshootEntity.create(validData);
      if (Result.isErr(entity)) throw new Error('Setup failed');

      // Insert first time (succeeds)
      await repository.save(entity.value);

      // Insert again with same ID (fails)
      const result = await repository.save(entity.value);

      expect(Result.isErr(result)).toBe(true);
      if (Result.isErr(result)) {
        expect(result.error.code).toBe('DUPLICATE_KEY');
      }
    });
  });

  describe('findById', () => {
    it('retrieves existing entity', async () => {
      // Seed database
      await db.insert(photoshoots).values(testData);

      const result = await repository.findById(testData.id);

      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        expect(result.value).not.toBeNull();
        expect(result.value?.id).toBe(testData.id);
      }
    });

    it('returns null for non-existent entity', async () => {
      const result = await repository.findById('non-existent-id');

      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        expect(result.value).toBeNull();
      }
    });
  });
});
```

**Key patterns:**
- Use PGlite for fast in-memory database
- Run migrations in beforeEach
- Test real database operations
- Test constraint violations
- Verify data with direct queries

---

## Critical Testing Rules

### ✅ MUST DO

1. **Use Result<T,E> type guards**
   ```typescript
   // ✅ CORRECT
   if (Result.isOk(result)) {
     console.log(result.value);
   }

   // ❌ WRONG - Type error!
   if (result.ok) {
     console.log(result.value);
   }
   ```

2. **Mock at architectural boundaries**
   ```typescript
   // ✅ CORRECT - Mock port in application layer
   const mockRepo: IPhotoshootRepository = { ... };

   // ❌ WRONG - Don't mock domain logic
   const mockEntity = vi.fn(PhotoshootEntity.create);
   ```

3. **Test all error cases**
   ```typescript
   describe('error cases', () => {
     it('handles validation errors', () => { ... });
     it('handles repository errors', () => { ... });
     it('handles network errors', () => { ... });
   });
   ```

4. **Create contract tests for ports**
   ```typescript
   describe.each([
     ['Real', realImpl],
     ['Mock', mockImpl]
   ])('%s implementation', (name, impl) => {
     // Test both follow same contract
   });
   ```

5. **Place mocks in infrastructure/mocks/**
   ```
   src/modules/photoshoot/
   └── infrastructure/
       └── mocks/
           ├── MockPhotoshootRepository.ts
           └── MockPaymentService.ts
   ```

### ❌ MUST NOT DO

1. **Don't modify production code**
   - Tests should be in `__tests__/` subdirectories or `.test.ts` files
   - Verify: `git diff dev --name-only | grep -v test`

2. **Don't check .ok property**
   ```typescript
   // ❌ WRONG - Type error
   if (result.ok) { ... }

   // ✅ CORRECT
   if (Result.isOk(result)) { ... }
   ```

3. **Don't mock domain logic**
   ```typescript
   // ❌ WRONG
   vi.fn(PhotoshootEntity.create)

   // ✅ CORRECT - Test directly
   const result = PhotoshootEntity.create(data);
   ```

4. **Don't test framework boilerplate**
   ```typescript
   // ❌ WRONG - Testing framework, not our code
   it('exports CreatePhotoshootUseCase', () => {
     expect(CreatePhotoshootUseCase).toBeDefined();
   });
   ```

5. **Don't skip error cases**
   ```typescript
   // ❌ INCOMPLETE - Only happy path
   it('creates photoshoot', () => { ... });

   // ✅ COMPLETE - Happy + error paths
   describe('create', () => {
     it('succeeds with valid data', () => { ... });
     it('fails with invalid data', () => { ... });
     it('handles repository errors', () => { ... });
   });
   ```

---

## Common Pitfalls

### Pitfall 1: Testing Implementation Details

```typescript
// ❌ WRONG - Testing internal state
expect(useCase.repository).toHaveBeenCalled();

// ✅ CORRECT - Testing observable behavior
const result = await useCase.execute(input);
expect(Result.isOk(result)).toBe(true);
```

### Pitfall 2: Not Testing Edge Cases

```typescript
// ❌ INCOMPLETE
it('validates title', () => {
  const result = Entity.create({ title: '' });
  expect(Result.isErr(result)).toBe(true);
});

// ✅ COMPLETE - Test boundaries
it.each([
  ['empty string', ''],
  ['whitespace only', '   '],
  ['too long', 'a'.repeat(256)],
  ['null', null],
  ['undefined', undefined]
])('rejects invalid title: %s', (name, title) => {
  const result = Entity.create({ title });
  expect(Result.isErr(result)).toBe(true);
});
```

### Pitfall 3: Leaky Test State

```typescript
// ❌ WRONG - Shared mutable state
const mockRepo = { data: [] };

it('test 1', () => {
  mockRepo.data.push(item);  // Mutates shared state
});

it('test 2', () => {
  expect(mockRepo.data).toHaveLength(0);  // FAILS - has item from test 1
});

// ✅ CORRECT - Fresh state per test
beforeEach(() => {
  mockRepo = { data: [] };  // Reset for each test
});
```

### Pitfall 4: Not Using Type Guards

```typescript
// ❌ WRONG - Runtime error if Result.isErr
const value = result.value;

// ✅ CORRECT - Type-safe access
if (Result.isOk(result)) {
  const value = result.value;  // TypeScript knows this is safe
}
```

---

## Example Execution Flow

### User Request
```
/test-layer photoshoot core
```

### Phase 1: Analysis Output
```
📊 Analysis: photoshoot/core

Files to test: 2 files (450 lines)
Current coverage: 50%
Target coverage: 90%

Testable files:
  ✅ Photoshoot.ts (250 lines) - Entity with complex validation
  ✅ PhotoshootStateMachine.ts (150 lines) - State transitions
  ❌ PhotoshootStatus.ts - SKIP (enum without logic)
  ❌ PhotoshootEvents.ts - SKIP (event definitions)

Ready to proceed? [yes]
```

### Phase 2: Worktree Creation
```
🌳 Worktree Created

Branch: test/photoshoot-core-coverage
Location: /home/user/projects/moment-photographie-photoshoot-core
Status: Ready for testing agent
```

### Phase 3: Agent Working
```
🤖 Testing Agent Spawned

Working in: /home/user/projects/moment-photographie-photoshoot-core
Target: 90% coverage
Strategy: Core/Domain layer testing

[Agent works autonomously...]
```

### Phase 4: Results Summary
```
✅ Testing Complete!

📊 Coverage Achieved:
  Statements: 95%
  Branches: 92%
  Functions: 100%
  Lines: 95%

📝 Tests Created:
  - Photoshoot.test.ts (35 tests, 450 lines)
  - PhotoshootStateMachine.test.ts (18 tests, 250 lines)

Total: 53 tests, 700 lines of test code

🔒 Safety Check:
  Production changes: 0 ✅
  All tests passing: ✅
  Type-check: ✅

💾 Commit:
  Branch: test/photoshoot-core-coverage
  Hash: abc123de
  Message: "test(photoshoot): add core layer comprehensive tests"

📍 Location: /home/user/projects/moment-photographie-photoshoot-core
```

### Phase 5: Next Steps
```
🎯 Next Recommended Layer

Module: photoshoot
Layer: application
Reason: Core is complete, application layer depends on it
Estimated effort: 2-3 hours (6 use cases to test)

Command: /test-layer photoshoot application
```

---

## Success Metrics

Track for each `/test-layer` execution:

| Metric | Target | Notes |
|--------|--------|-------|
| Time to completion | 1-4 hours | Depends on layer size |
| Coverage achieved | >= Target | 90% core, 80% app, 70% infra |
| Tests created | N/A | Track count and LOC |
| Production changes | 0 | CRITICAL - tests only |
| Quality gates passed | 5/5 | Coverage, tests, types, lint, safety |
| Unreachable code found | Document | Indicates dead code |

---

## FAQ

**Q: Should I test private methods?**
A: No. Test public interface only. If private method is complex enough to need testing, it should probably be a separate class.

**Q: What if I can't reach the coverage target?**
A: Investigate why:
- Unreachable code? Remove it.
- Framework boilerplate? Exclude from coverage.
- Complex error handling? Test it.
- Real constraint? Document and adjust target.

**Q: Should I test getters/setters?**
A: Only if they contain logic. Simple property access doesn't need tests.

**Q: How do I test async code?**
A: Use `async/await` in tests, ensure proper error handling, use `vi.useFakeTimers()` for time-dependent code.

**Q: What about snapshot tests?**
A: Use sparingly. Prefer explicit assertions. Snapshots are good for complex JSON structures, but avoid for simple data.
