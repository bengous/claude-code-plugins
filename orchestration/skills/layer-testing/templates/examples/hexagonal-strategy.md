# Testing Strategy - Hexagonal Architecture

> Example testing strategy for hexagonal (ports & adapters) architecture
> Updated: 2024-11-15
> Architecture: Hexagonal (Ports & Adapters)

---

## Architecture Overview

**Hexagonal Architecture** (also called Ports & Adapters) organizes code in concentric layers:
- **Core/Domain**: Business logic, entities, value objects (dependency-free)
- **Application**: Use cases, orchestration, port interfaces
- **Infrastructure**: Port implementations, repositories, external adapters
- **Boundary**: Controllers, APIs, framework integration

**Module organization:**
```
src/
└── modules/
    ├── auth/
    │   ├── core/          # Domain logic
    │   ├── application/   # Use cases + ports
    │   ├── infrastructure/# Port implementations
    │   └── boundary/      # Controllers/APIs
    └── photoshoot/
        └── ...
```

**Key principles**:
- Core has zero external dependencies
- Application defines port interfaces, infrastructure implements them
- Dependencies point inward (infrastructure → application → core)

---

## Layer Definitions

### Core/Domain Layer

- **Path pattern**: `src/modules/*/core/**` or `src/modules/*/domain/**`
- **Coverage target**: 90-100%
- **Philosophy**: Test business rules and invariants

**What to test**:
- Entities (especially `.create()` factory methods and business rules)
- Value objects (validation logic, equality, immutability)
- State machines (all valid and invalid transitions)
- Domain services (pure business logic)

**What to skip**:
- Events (data containers, no logic)
- Type definitions (no behavior to test)
- Re-exports (index.ts files)
- Enums without validation logic

**Testing approach**:
- **Pure unit tests** (no mocks - core is dependency-free)
- Test validation rules exhaustively
- Test all state transitions
- Test business invariants
- Test Result<T,E> error cases

**Example files**:
```
PhotoshootEntity.create()        ✅ Test all validation rules
PhotoshootStateMachine           ✅ Test all state transitions
PhotoshootStatus (enum)          ❌ Skip (no logic)
PhotoshootCreatedEvent           ❌ Skip (data container)
```

**Reference test**: `src/modules/photoshoot/core/__tests__/PhotoshootEntity.test.ts`

---

### Application Layer

- **Path pattern**: `src/modules/*/application/**`
- **Coverage target**: 80-90%
- **Philosophy**: Test orchestration and business workflows

**What to test**:
- Use cases (orchestration logic, business flows)
- Policies (business rules applied in use cases)
- Application services

**What to skip**:
- Port interfaces (test implementations instead)
- Simple DTOs (no behavior)
- Event handlers (test in integration tests)

**Testing approach**:
- **Mock all ports** (repositories, external services, etc.)
- Test business logic flows
- Test error handling paths
- **CRITICAL**: Create contract tests for all port implementations

**Example files**:
```
CreatePhotoshootUseCase          ✅ Test orchestration logic (mock ports)
IPhotoshootRepository (port)     ❌ Skip (interface has no behavior)
PhotoshootRepository (impl)      ✅ Test via contract tests
PhotoshootPolicy                 ✅ Test business rules
```

**Reference test**: `src/modules/photoshoot/application/__tests__/CreatePhotoshoot.test.ts`

---

### Infrastructure Layer

- **Path pattern**: `src/modules/*/infrastructure/**`
- **Coverage target**: 60-80%
- **Philosophy**: Test I/O and external integrations

**What to test**:
- Repositories (database operations with real DB)
- Adapters with business logic (transformation, error mapping)
- External service clients
- Data mappers with complex transformations

**What to skip**:
- Schema definitions (Drizzle schemas, no behavior)
- Simple wrappers (thin delegation, no logic)
- Existing mocks (they're test helpers)
- Generated code

**Testing approach**:
- **Integration tests with PGlite** (in-memory PostgreSQL)
- Test real I/O operations
- Mock only external APIs (network, third-party services)
- Test error cases (network failures, DB constraints)

**Example files**:
```
PhotoshootRepository             ✅ Integration test with PGlite
PhotoshootSchema (Drizzle)       ❌ Skip (schema definition)
MockPhotoshootRepository         ❌ Skip (test helper)
S3StorageAdapter                 ✅ Integration test or mock S3
```

**Reference test**: `src/modules/photoshoot/infrastructure/__tests__/PostgresPhotoRepository.test.ts`

---

### Boundary Layer

- **Path pattern**: `src/modules/*/boundary/**`
- **Coverage target**: 10-20%
- **Philosophy**: Prefer E2E tests over unit tests

**What to test**:
- Only if transformation/validation logic exists
- Complex request/response mapping
- Input sanitization logic beyond type checking

**What to skip**:
- Simple delegation to application layer (no logic)
- Framework boilerplate
- Routing configuration

**Testing approach**:
- **E2E tests preferred** (test full request cycle)
- If unit testing: test transformation logic only
- Integration tests with real HTTP requests

**Example files**:
```
PhotoshootController             ❌ Skip (simple delegation) - E2E test instead
CreatePhotoshootDTO (validation) ✅ Test if complex validation exists
PhotoshootResponseMapper         ✅ Test if transformation logic exists
```

**Reference test**: E2E tests in `tests/e2e/` directory

---

## Testing Patterns

### Pattern 1: Entity Validation Tests

**When to use**: Testing `.create()` factory methods on entities

**Pattern**:
```typescript
import { Result } from '@/lib/result';
import { PhotoshootEntity } from './PhotoshootEntity';

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

---

### Pattern 2: Use Case Tests with Mocked Ports

**When to use**: Testing application layer use cases

**Pattern**:
```typescript
import { CreatePhotoshootUseCase } from './CreatePhotoshootUseCase';
import { IPhotoshootRepository } from './ports/IPhotoshootRepository';
import { IEventBus } from './ports/IEventBus';

describe('CreatePhotoshootUseCase', () => {
  let useCase: CreatePhotoshootUseCase;
  let mockRepository: vi.Mocked<IPhotoshootRepository>;
  let mockEventBus: vi.Mocked<IEventBus>;

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
  });
});
```

---

### Pattern 3: Contract Tests for Ports

**When to use**: Ensuring port implementations and mocks behave identically

**Pattern**:
```typescript
import { IPhotoshootRepository } from '@/modules/photoshoot/application/ports/IPhotoshootRepository';
import { PostgresPhotoshootRepository } from '@/modules/photoshoot/infrastructure/PostgresPhotoshootRepository';
import { MockPhotoshootRepository } from '@/modules/photoshoot/infrastructure/mocks/MockPhotoshootRepository';

describe.each([
  ['Real Implementation', () => new PostgresPhotoshootRepository(db)],
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

  it('handles errors gracefully', async () => {
    const result = await adapter.save(invalidEntity);

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.code).toBeDefined();
    }
  });
});
```

---

### Pattern 4: Integration Tests with PGlite

**When to use**: Testing repository implementations with real database

**Pattern**:
```typescript
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from '@/db/migrate';
import { PostgresPhotoshootRepository } from './PostgresPhotoshootRepository';

describe('PostgresPhotoshootRepository (integration)', () => {
  let db: PGliteDatabase;
  let repository: PostgresPhotoshootRepository;

  beforeEach(async () => {
    // Create in-memory test database
    const client = new PGlite();
    db = drizzle(client);

    // Run migrations
    await migrate(db, { migrationsFolder: './drizzle' });

    repository = new PostgresPhotoshootRepository(db);
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
});
```

---

## Framework & Tools

**Test runner**: Vitest
```bash
# Run tests
pnpm test

# Run with coverage
pnpm test --coverage

# Run specific layer
pnpm test src/modules/photoshoot/core
```

**Database testing**: PGlite (in-memory PostgreSQL)
**Mocking library**: Vitest built-in mocks (`vi.fn()`, `vi.mock()`)
**Assertion library**: Expect (Vitest)
**Coverage tool**: Vitest coverage (c8)

**Test file location**: Co-located in `__tests__/` subdirectories
```
src/modules/photoshoot/core/
├── PhotoshootEntity.ts
└── __tests__/
    └── PhotoshootEntity.test.ts
```

**Test file naming**: `*.test.ts`

---

## Critical Rules

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

2. **Mock at architectural boundaries (ports)**
   - Mock: Repositories, external services (infrastructure)
   - Don't mock: Entities, value objects (core)

3. **Create contract tests for all port implementations**
   - Ensures mocks and real implementations behave identically
   - Prevents mock drift

4. **Test happy path + error cases + edge cases**
   - Don't just test the success path
   - Every Result<T,E> should test both Ok and Err branches

5. **Place mocks in infrastructure/mocks/**
   ```
   src/modules/photoshoot/infrastructure/
   └── mocks/
       ├── MockPhotoshootRepository.ts
       └── MockPaymentService.ts
   ```

6. **Use PGlite for database integration tests**
   - Fast in-memory PostgreSQL
   - Real SQL execution (not mocks)
   - Clean state per test

### ❌ MUST NOT DO

1. **Modify production code in test commits**
   - Tests-only workflow must not change production
   - File bugs separately if issues found

2. **Mock domain logic**
   ```typescript
   // ❌ WRONG - Don't mock entities
   const mockEntity = vi.fn(PhotoshootEntity.create);

   // ✅ CORRECT - Test entities directly
   const result = PhotoshootEntity.create(data);
   ```

3. **Test framework boilerplate**
   ```typescript
   // ❌ WRONG - Testing framework, not our code
   it('exports CreatePhotoshootUseCase', () => {
     expect(CreatePhotoshootUseCase).toBeDefined();
   });
   ```

4. **Skip error case testing**
   - Every function that returns Result<T,E> must test Err cases
   - Error handling is critical in hexagonal architecture

5. **Check .ok property instead of Result.isOk()**
   - Type error in TypeScript
   - Not type-safe

---

## Project-Specific Patterns

### Result<T,E> Error Handling

**Description**: All operations that can fail return `Result<T,E>` instead of throwing exceptions.

**Example**:
```typescript
// Function signature
function createUser(data: UserData): Result<User, ValidationError>

// Success case
Result.ok(user)

// Error case
Result.err({ code: 'VALIDATION_ERROR', message: 'Invalid email' })
```

**Testing guideline**:
- ALWAYS use `Result.isOk()` and `Result.isErr()` type guards
- Test both Ok and Err branches
- Never access `.value` or `.error` without type guard

### Port/Adapter Pattern

**Description**: Application layer defines port interfaces, infrastructure implements them.

**Example**:
```typescript
// Application layer: Port interface
export interface IUserRepository {
  save(user: User): Promise<Result<User, RepositoryError>>;
  findById(id: string): Promise<Result<User | null, RepositoryError>>;
}

// Infrastructure layer: Implementation
export class PostgresUserRepository implements IUserRepository {
  // ... implementation
}
```

**Testing guideline**:
- Mock ports in application layer tests
- Create contract tests to verify implementations
- Integration test real implementations

---

## Edge Cases & Special Scenarios

### Scenario: Async Result Handling

**Guideline**: Await async Results before using type guards

**Example**:
```typescript
it('handles async repository calls', async () => {
  const result = await repository.save(user);  // Await first

  expect(Result.isOk(result)).toBe(true);  // Then type guard
  if (Result.isOk(result)) {
    expect(result.value.id).toBeDefined();
  }
});
```

---

### Scenario: State Machine Transitions

**Guideline**: Test all valid and invalid transitions

**Example**:
```typescript
describe('PhotoshootStateMachine', () => {
  it('allows DRAFT -> CONFIRMED transition', () => {
    const result = machine.transition('DRAFT', 'CONFIRMED');
    expect(Result.isOk(result)).toBe(true);
  });

  it('blocks COMPLETED -> DRAFT transition', () => {
    const result = machine.transition('COMPLETED', 'DRAFT');
    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.code).toBe('INVALID_TRANSITION');
    }
  });
});
```

---

## Coverage Philosophy

**Overall target**: 80% (varies by layer)

**Layer-specific rationale**:
- **Core/Domain: 90-100%** - Business logic is critical, must be well-tested
- **Application: 80-90%** - Orchestration is important, but some paths are defensive
- **Infrastructure: 60-80%** - I/O testing is valuable but integration tests cover most
- **Boundary: 10-20%** - Prefer E2E tests; unit tests only for transformation logic

**When to accept lower coverage**:
- Complex integration logic requiring external services (test manually or E2E)
- Framework boilerplate (exclude from coverage)
- Defensive code for impossible edge cases (document as unreachable)

**When coverage isn't enough**:
- **Test quality matters more than coverage percentage**
- Ensure both Ok and Err branches tested
- Ensure edge cases tested (empty strings, null, boundaries)
- Ensure contract tests exist for all ports

---

## Team Conventions

**Test data factories**: `src/test-utils/factories/`
```typescript
export function createValidPhotoshootData() {
  return {
    title: 'Test Photoshoot',
    date: new Date('2025-12-31'),
    location: 'Paris'
  };
}
```

**Setup helpers**: `src/test-utils/setup/`
```typescript
export async function createTestDb() {
  const client = new PGlite();
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: './drizzle' });
  return db;
}
```

**Shared mocks**: `src/modules/[module]/infrastructure/mocks/`

**Test utilities**: `src/test-utils/`

---

## Resources

- [Hexagonal Architecture Guide](https://alistair.cockburn.us/hexagonal-architecture/)
- [Result Type Pattern](./references/result-type-patterns.md)
- [Quality Gates](./references/quality-gates.md)
- [Vitest Documentation](https://vitest.dev/)
- [PGlite Documentation](https://github.com/electric-sql/pglite)

---

## Version History

- **2024-11-15**: Initial hexagonal architecture testing strategy
- **2024-11-15**: Added Result<T,E> type guard patterns
- **2024-11-15**: Added contract testing for ports

---

## Notes

- This strategy emphasizes type-safe error handling with Result<T,E>
- Port/adapter pattern requires contract tests to ensure mock fidelity
- PGlite enables fast, real database integration tests
- Core layer has highest coverage target (90-100%) as it contains business rules
