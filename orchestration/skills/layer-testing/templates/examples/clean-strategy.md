# Testing Strategy - Clean Architecture

> Example testing strategy for Clean Architecture
> Updated: 2024-11-15
> Architecture: Clean Architecture

---

## Architecture Overview

**Clean Architecture** organizes code in concentric circles:
- **Entities**: Enterprise business rules (innermost)
- **Use Cases**: Application business rules
- **Interface Adapters**: Controllers, presenters, gateways
- **Frameworks & Drivers**: UI, DB, external agencies (outermost)

**Module organization:**
```
src/
├── entities/
│   └── [domain-entities]
├── usecases/
│   └── [application-logic]
├── adapters/
│   ├── controllers/
│   ├── presenters/
│   └── gateways/
└── infrastructure/
    ├── database/
    ├── api/
    └── ui/
```

**Dependency rule**: Dependencies point inward. Inner layers know nothing about outer layers.

---

## Layer Definitions

### Entities Layer

- **Path pattern**: `src/entities/**`
- **Coverage target**: 95%
- **Philosophy**: Test enterprise business rules

**What to test**:
- Entity classes (business rules and invariants)
- Entity factories
- Business rule validators
- Domain events

**What to skip**:
- Simple data transfer objects
- Type definitions

**Testing approach**:
- Pure unit tests (no dependencies)
- Test all business rules
- Test entity lifecycle
- Test invariants

**Example**:
```typescript
describe('UserEntity', () => {
  it('enforces email uniqueness business rule', () => {
    const user = new UserEntity({ email: 'test@example.com' });
    expect(user.isValid()).toBe(true);
  });

  it('validates password strength requirement', () => {
    const user = new UserEntity({ email: 'test@example.com', password: 'weak' });
    expect(user.isValid()).toBe(false);
    expect(user.errors).toContain('PASSWORD_TOO_WEAK');
  });
});
```

---

### Use Cases Layer

- **Path pattern**: `src/usecases/**`
- **Coverage target**: 85%
- **Philosophy**: Test application business rules

**What to test**:
- Use case interactors
- Input/output ports
- Application-specific business rules

**What to skip**:
- Port interfaces (test implementations)
- Simple DTOs

**Testing approach**:
- Mock gateways and presenters
- Test use case logic
- Test error handling
- Test authorization rules

**Example**:
```typescript
describe('CreateUserUseCase', () => {
  let useCase: CreateUserUseCase;
  let mockUserGateway: MockUserGateway;
  let mockPresenter: MockPresenter;

  beforeEach(() => {
    mockUserGateway = new MockUserGateway();
    mockPresenter = new MockPresenter();
    useCase = new CreateUserUseCase(mockUserGateway);
  });

  it('creates user and presents success', async () => {
    const input = { email: 'test@example.com', password: 'Strong123!' };

    await useCase.execute(input, mockPresenter);

    expect(mockUserGateway.savedUsers).toHaveLength(1);
    expect(mockPresenter.successCalled).toBe(true);
  });

  it('presents error when email already exists', async () => {
    mockUserGateway.existingEmails = ['test@example.com'];
    const input = { email: 'test@example.com', password: 'Strong123!' };

    await useCase.execute(input, mockPresenter);

    expect(mockPresenter.errorCalled).toBe(true);
    expect(mockPresenter.error).toBe('EMAIL_ALREADY_EXISTS');
  });
});
```

---

### Interface Adapters Layer

- **Path pattern**: `src/adapters/**`
- **Coverage target**: 70%
- **Philosophy**: Test data conversion and presentation

**What to test**:
- Controllers (request handling)
- Presenters (response formatting)
- Gateways (external service adapters)
- View models

**What to skip**:
- Framework boilerplate
- Simple pass-through code

**Testing approach**:
- Mock use cases
- Test request/response transformation
- Integration tests for gateways
- Test error handling

**Example**:
```typescript
describe('UserController', () => {
  let controller: UserController;
  let mockCreateUserUseCase: MockCreateUserUseCase;

  beforeEach(() => {
    mockCreateUserUseCase = new MockCreateUserUseCase();
    controller = new UserController(mockCreateUserUseCase);
  });

  it('transforms HTTP request to use case input', async () => {
    const httpRequest = {
      body: { email: 'test@example.com', password: 'Strong123!' }
    };

    await controller.createUser(httpRequest);

    expect(mockCreateUserUseCase.input).toEqual({
      email: 'test@example.com',
      password: 'Strong123!'
    });
  });
});
```

---

### Infrastructure Layer

- **Path pattern**: `src/infrastructure/**`
- **Coverage target**: 60%
- **Philosophy**: Test external integrations

**What to test**:
- Database repositories (with real DB)
- API clients
- Framework-specific code with logic

**What to skip**:
- Configuration files
- Framework setup code

**Testing approach**:
- Integration tests with real dependencies (in-memory DB, test API)
- Test error handling (network failures, DB errors)

**Example**:
```typescript
describe('PostgresUserRepository', () => {
  let db: Database;
  let repository: PostgresUserRepository;

  beforeEach(async () => {
    db = await createTestDatabase();
    repository = new PostgresUserRepository(db);
  });

  it('saves user to database', async () => {
    const user = new UserEntity({ email: 'test@example.com' });

    await repository.save(user);

    const saved = await repository.findByEmail('test@example.com');
    expect(saved.email).toBe('test@example.com');
  });
});
```

---

## Critical Rules

### ✅ MUST DO

1. **Follow dependency rule** - Tests should not violate clean architecture layers
2. **Mock outer layers** - When testing inner layers, mock dependencies from outer layers
3. **Integration test adapters** - Gateways and repositories need real external dependencies
4. **Test business rules exhaustively** - Entities and use cases contain critical logic
5. **Use in-memory implementations** - For fast integration tests (in-memory DB, fake services)

### ❌ MUST NOT DO

1. **Don't let tests depend on frameworks** - Tests should survive framework changes
2. **Don't mock entities** - Entities are pure logic, test directly
3. **Don't test framework code** - Only test YOUR code, not the framework's
4. **Don't skip error cases** - Every error path needs tests
5. **Don't violate layer boundaries in tests** - Tests should respect architecture

---

## Framework & Tools

**Test runner**: Jest
```bash
npm test
npm test -- --coverage
```

**Database testing**: In-memory SQLite or PostgreSQL
**Mocking**: jest.fn() for mocks, manual fake implementations for complex dependencies

**Test file location**: Co-located with source
```
src/usecases/
├── CreateUser.ts
└── CreateUser.test.ts
```

---

## Coverage Philosophy

- **Entities: 95%** - Business rules are critical
- **Use Cases: 85%** - Application logic needs thorough testing
- **Adapters: 70%** - Transformation and error handling
- **Infrastructure: 60%** - Integration tests cover most scenarios

**Quality over coverage**: A few well-designed tests beat many shallow ones.

---

## Resources

- [Clean Architecture Book](https://www.amazon.com/Clean-Architecture-Craftsmans-Software-Structure/dp/0134494164)
- [Clean Architecture Blog](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html)

---

## Notes

- Clean Architecture emphasizes testability
- Inner layers (entities, use cases) have highest coverage
- Outer layers (adapters, infrastructure) use integration tests
- Framework independence enables long-lived tests
