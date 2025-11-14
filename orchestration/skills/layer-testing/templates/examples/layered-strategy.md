# Testing Strategy - Layered Architecture

> Example testing strategy for traditional layered (3-tier) architecture
> Updated: 2024-11-15
> Architecture: Layered (3-tier)

---

## Architecture Overview

**Layered Architecture** organizes code in horizontal layers:
- **Presentation**: UI, controllers, views
- **Business Logic**: Services, domain models, business rules
- **Data Access**: Repositories, DAOs, database

**Module organization:**
```
src/
├── presentation/
│   ├── controllers/
│   ├── middleware/
│   └── views/
├── business/
│   ├── services/
│   └── models/
└── data/
    ├── repositories/
    └── models/
```

**Dependencies flow downward**: Presentation → Business → Data

---

## Layer Definitions

### Presentation Layer

- **Path pattern**: `src/presentation/**`
- **Coverage target**: 40%
- **Philosophy**: Prefer E2E tests; unit test complex logic only

**What to test**:
- Request validation with complex rules
- Response transformation logic
- Middleware with business logic
- Error handling and formatting

**What to skip**:
- Simple routing
- Framework boilerplate
- Views/templates (test via E2E)

**Testing approach**:
- **E2E tests preferred** for full request/response cycle
- Unit tests for complex transformations
- Mock business layer services

**Example**:
```typescript
describe('UserController', () => {
  let controller: UserController;
  let mockUserService: jest.Mocked<UserService>;

  beforeEach(() => {
    mockUserService = {
      createUser: jest.fn(),
      findUser: jest.fn()
    } as any;

    controller = new UserController(mockUserService);
  });

  it('validates email format', async () => {
    const request = { body: { email: 'invalid', password: 'test123' } };

    const response = await controller.createUser(request);

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid email');
  });

  it('transforms service result to HTTP response', async () => {
    const user = { id: '1', email: 'test@example.com' };
    mockUserService.createUser.mockResolvedValue(user);

    const request = { body: { email: 'test@example.com', password: 'test123' } };
    const response = await controller.createUser(request);

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: '1',
      email: 'test@example.com'
    });
  });
});
```

---

### Business Logic Layer

- **Path pattern**: `src/business/**`
- **Coverage target**: 85%
- **Philosophy**: Test business rules thoroughly

**What to test**:
- Service classes (business logic orchestration)
- Domain models (business rules, validation)
- Business rule validators
- State management

**What to skip**:
- Simple getters/setters
- Pass-through methods

**Testing approach**:
- Mock data access layer
- Test all business rules
- Test error handling
- Test edge cases

**Example**:
```typescript
describe('UserService', () => {
  let service: UserService;
  let mockUserRepository: jest.Mocked<UserRepository>;

  beforeEach(() => {
    mockUserRepository = {
      save: jest.fn(),
      findByEmail: jest.fn()
    } as any;

    service = new UserService(mockUserRepository);
  });

  it('enforces unique email business rule', async () => {
    mockUserRepository.findByEmail.mockResolvedValue({ id: '1', email: 'existing@example.com' });

    await expect(
      service.createUser({ email: 'existing@example.com', password: 'test123' })
    ).rejects.toThrow('Email already exists');
  });

  it('hashes password before saving', async () => {
    mockUserRepository.save.mockResolvedValue({ id: '1', email: 'test@example.com', password: 'hashed' });

    await service.createUser({ email: 'test@example.com', password: 'plaintext' });

    expect(mockUserRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'test@example.com',
        password: expect.not.stringContaining('plaintext')
      })
    );
  });

  it('validates password strength', async () => {
    await expect(
      service.createUser({ email: 'test@example.com', password: 'weak' })
    ).rejects.toThrow('Password too weak');
  });
});
```

---

### Data Access Layer

- **Path pattern**: `src/data/**`
- **Coverage target**: 70%
- **Philosophy**: Test with real or in-memory database

**What to test**:
- Repository implementations (CRUD operations)
- Query builders
- Data mappers (entity ↔ DTO conversion)
- Transaction management

**What to skip**:
- ORM configuration
- Database schema definitions
- Simple pass-through queries

**Testing approach**:
- Integration tests with in-memory database
- Test CRUD operations
- Test complex queries
- Test error handling (constraints, connection errors)

**Example**:
```typescript
describe('UserRepository (integration)', () => {
  let repository: UserRepository;
  let database: Database;

  beforeEach(async () => {
    database = await createInMemoryDatabase();
    repository = new UserRepository(database);
  });

  afterEach(async () => {
    await database.close();
  });

  it('saves user to database', async () => {
    const user = { email: 'test@example.com', password: 'hashed' };

    const saved = await repository.save(user);

    expect(saved.id).toBeDefined();
    expect(saved.email).toBe('test@example.com');
  });

  it('finds user by email', async () => {
    await repository.save({ email: 'test@example.com', password: 'hashed' });

    const found = await repository.findByEmail('test@example.com');

    expect(found).toBeDefined();
    expect(found.email).toBe('test@example.com');
  });

  it('returns null when user not found', async () => {
    const found = await repository.findByEmail('nonexistent@example.com');

    expect(found).toBeNull();
  });

  it('handles unique constraint violation', async () => {
    await repository.save({ email: 'test@example.com', password: 'hashed' });

    await expect(
      repository.save({ email: 'test@example.com', password: 'hashed2' })
    ).rejects.toThrow('Duplicate email');
  });
});
```

---

## Testing Patterns

### Pattern 1: Service Layer Tests (Business Logic)

**When to use**: Testing service classes with business rules

**Pattern**:
```typescript
describe('OrderService', () => {
  let service: OrderService;
  let mockOrderRepository: jest.Mocked<OrderRepository>;
  let mockInventoryService: jest.Mocked<InventoryService>;

  beforeEach(() => {
    mockOrderRepository = createMockRepository();
    mockInventoryService = createMockInventoryService();
    service = new OrderService(mockOrderRepository, mockInventoryService);
  });

  describe('createOrder', () => {
    it('checks inventory before creating order', async () => {
      mockInventoryService.checkAvailability.mockResolvedValue(true);

      await service.createOrder({ productId: '1', quantity: 5 });

      expect(mockInventoryService.checkAvailability).toHaveBeenCalledWith('1', 5);
    });

    it('rejects order when inventory insufficient', async () => {
      mockInventoryService.checkAvailability.mockResolvedValue(false);

      await expect(
        service.createOrder({ productId: '1', quantity: 5 })
      ).rejects.toThrow('Insufficient inventory');

      expect(mockOrderRepository.save).not.toHaveBeenCalled();
    });
  });
});
```

---

### Pattern 2: Repository Integration Tests

**When to use**: Testing data access layer with real database

**Pattern**:
```typescript
describe('ProductRepository (integration)', () => {
  let repository: ProductRepository;
  let db: Database;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM products');  // Clean slate
  });

  afterAll(async () => {
    await db.close();
  });

  it('performs complex query with joins', async () => {
    // Seed data
    await db.query('INSERT INTO categories VALUES (?, ?)', [1, 'Electronics']);
    await db.query('INSERT INTO products VALUES (?, ?, ?)', [1, 'Laptop', 1]);

    const products = await repository.findByCategory('Electronics');

    expect(products).toHaveLength(1);
    expect(products[0].name).toBe('Laptop');
    expect(products[0].category).toBe('Electronics');
  });
});
```

---

## Framework & Tools

**Test runner**: Jest
```bash
npm test
npm test -- --coverage
npm test -- --watch
```

**Database testing**: SQLite in-memory or testcontainers
**Mocking**: jest.mock(), jest.fn()
**Assertion**: Jest expect

**Test file location**: Next to source files
```
src/business/services/
├── UserService.ts
└── UserService.test.ts
```

---

## Critical Rules

### ✅ MUST DO

1. **Mock lower layers** - Presentation mocks business, business mocks data
2. **Integration test data layer** - Use real or in-memory database
3. **Test business rules thoroughly** - Business layer has highest coverage
4. **Test error paths** - Every error should have a test
5. **Use factories for test data** - Consistent, maintainable test data

### ❌ MUST NOT DO

1. **Don't test database/ORM** - Test YOUR code, not the framework
2. **Don't skip integration tests** - Data layer needs real database tests
3. **Don't test trivial code** - Simple getters/setters don't need tests
4. **Don't violate layer boundaries** - Tests should respect layers
5. **Don't use production database** - Always use test database

---

## Coverage Philosophy

- **Presentation: 40%** - Prefer E2E tests; unit test complex logic only
- **Business: 85%** - Business rules are critical, test thoroughly
- **Data: 70%** - Integration tests cover most scenarios

**Layer priority**:
1. Business layer (most important - business rules)
2. Data layer (important - persistence correctness)
3. Presentation layer (least important - covered by E2E)

**When to accept lower coverage**:
- Framework boilerplate
- Simple pass-through code
- Configuration files

---

## Team Conventions

**Test data factories**: `tests/factories/`
```typescript
export function createUser(overrides = {}) {
  return {
    email: 'test@example.com',
    password: 'hashed123',
    ...overrides
  };
}
```

**Database helpers**: `tests/helpers/database.ts`
```typescript
export async function createTestDatabase() {
  const db = new Database(':memory:');
  await runMigrations(db);
  return db;
}
```

**Mock builders**: `tests/mocks/`
```typescript
export function createMockUserRepository(): jest.Mocked<UserRepository> {
  return {
    save: jest.fn(),
    findByEmail: jest.fn(),
    findById: jest.fn()
  } as any;
}
```

---

## Resources

- [Layered Architecture Overview](https://www.oreilly.com/library/view/software-architecture-patterns/9781491971437/ch01.html)
- [Testing Patterns](https://martinfowler.com/articles/practical-test-pyramid.html)
- [Jest Documentation](https://jestjs.io/)

---

## Notes

- Layered architecture is straightforward to test
- Business layer is the most important to test thoroughly
- Integration tests are essential for data layer
- Presentation layer is better tested with E2E tests
- Each layer should only depend on the layer below it
