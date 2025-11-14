# Result<T,E> Type Patterns

This document explains the Result<T,E> pattern and how to test it correctly in TypeScript.

---

## What is Result<T,E>?

`Result<T,E>` is a type-safe error handling pattern that represents either:
- **Ok**: Success with value of type `T`
- **Err**: Failure with error of type `E`

This is an alternative to throwing exceptions, making error handling explicit and type-safe.

---

## Why It Matters for Testing

The Result pattern requires **type guards** to access values safely. Tests MUST use these type guards to:
1. **Avoid type errors**: TypeScript won't compile without type guards
2. **Narrow types correctly**: Enables access to `.value` or `.error`
3. **Test error cases properly**: Distinguish between Ok and Err branches

---

## Correct Patterns

### ✅ Testing Success Case

```typescript
import { Result } from '@/lib/result';
import { UserEntity } from './UserEntity';

describe('UserEntity.create()', () => {
  it('creates user with valid data', () => {
    const result = UserEntity.create({
      name: 'Alice',
      email: 'alice@example.com'
    });

    // ✅ CORRECT: Use Result.isOk() type guard
    expect(Result.isOk(result)).toBe(true);

    // ✅ CORRECT: Narrow type in if block
    if (Result.isOk(result)) {
      // TypeScript knows result.value exists here
      expect(result.value.name).toBe('Alice');
      expect(result.value.email).toBe('alice@example.com');
    } else {
      // This should never happen in this test
      throw new Error('Expected Ok result');
    }
  });
});
```

**Why this works**:
- `Result.isOk(result)` returns `true` if result is Ok variant
- TypeScript narrows the type inside the `if` block
- Can safely access `result.value`

### ✅ Testing Error Case

```typescript
describe('UserEntity.create()', () => {
  it('rejects empty name', () => {
    const result = UserEntity.create({
      name: '',
      email: 'alice@example.com'
    });

    // ✅ CORRECT: Use Result.isErr() type guard
    expect(Result.isErr(result)).toBe(true);

    // ✅ CORRECT: Narrow type in if block
    if (Result.isErr(result)) {
      // TypeScript knows result.error exists here
      expect(result.error.code).toBe('VALIDATION_ERROR');
      expect(result.error.message).toContain('name');
    } else {
      // This should never happen in this test
      throw new Error('Expected Err result');
    }
  });
});
```

**Why this works**:
- `Result.isErr(result)` returns `true` if result is Err variant
- TypeScript narrows the type inside the `if` block
- Can safely access `result.error`

### ✅ Testing Both Branches

```typescript
describe('UserValidator.validateEmail()', () => {
  it.each([
    ['valid@example.com', true],
    ['invalid-email', false],
    ['', false],
    ['missing-at-sign.com', false],
  ])('validates "%s" as %s', (email, shouldBeValid) => {
    const result = UserValidator.validateEmail(email);

    if (shouldBeValid) {
      // ✅ CORRECT: Expect Ok
      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        expect(result.value).toBe(email);
      }
    } else {
      // ✅ CORRECT: Expect Err
      expect(Result.isErr(result)).toBe(true);
      if (Result.isErr(result)) {
        expect(result.error.code).toBe('INVALID_EMAIL');
      }
    }
  });
});
```

**Why this works**:
- Tests both success and failure paths
- Uses parameterized tests for efficiency
- Each branch uses appropriate type guard

---

## Incorrect Patterns

### ❌ Accessing .ok Property Directly

```typescript
// ❌ WRONG: Type error!
const result = UserEntity.create(data);
expect(result.ok).toBe(true);  // TypeScript error: Property 'ok' does not exist

// ❌ WRONG: Even if it compiled, it's not type-safe
if (result.ok) {
  expect(result.value).toBe(expected);  // Type error: 'value' might not exist
}
```

**Why this fails**:
- Result type doesn't have an `.ok` property
- Some Result implementations do, but not type-safe
- Type guards are the only safe way

### ❌ Accessing .value Without Type Guard

```typescript
// ❌ WRONG: Type error!
const result = UserEntity.create(data);
expect(result.value.name).toBe('Alice');  // TypeScript error: 'value' might not exist
```

**Why this fails**:
- TypeScript doesn't know if result is Ok or Err
- `.value` only exists on Ok variant
- Must use type guard first

### ❌ Using Type Assertion Instead of Type Guard

```typescript
// ❌ WRONG: Unsafe type assertion
const result = UserEntity.create(data);
expect((result as any).value.name).toBe('Alice');  // Compiles but unsafe!
```

**Why this fails**:
- Bypasses type safety (defeats purpose of Result pattern)
- If result is Err, runtime error
- Tests should be type-safe

### ❌ Throwing Without Type Guard

```typescript
// ❌ WRONG: Not type-safe
const result = UserEntity.create(data);
if (!Result.isOk(result)) {
  throw result.error;  // Type error: 'error' might not exist
}
```

**Why this fails**:
- Using `!Result.isOk()` doesn't narrow to Err type
- Must use `Result.isErr()` explicitly

**Correct version**:
```typescript
// ✅ CORRECT
const result = UserEntity.create(data);
if (Result.isErr(result)) {
  throw result.error;  // Safe: TypeScript knows error exists
}
```

---

## Advanced Patterns

### Testing Async Results

```typescript
describe('UserRepository.save()', () => {
  it('saves user successfully', async () => {
    const user = UserEntity.create(validData);
    if (Result.isErr(user)) throw new Error('Setup failed');

    // ✅ CORRECT: Await async Result
    const result = await repository.save(user.value);

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.id).toBeDefined();
    }
  });

  it('handles database errors', async () => {
    const user = UserEntity.create(validData);
    if (Result.isErr(user)) throw new Error('Setup failed');

    // Force database error (implementation-specific)
    mockDb.save.mockRejectedValue(new Error('Connection failed'));

    const result = await repository.save(user.value);

    // ✅ CORRECT: Test error Result
    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.code).toBe('DATABASE_ERROR');
      expect(result.error.message).toContain('Connection failed');
    }
  });
});
```

### Chaining Results in Tests

```typescript
describe('CreateUserUseCase', () => {
  it('creates and saves user', async () => {
    // Step 1: Create entity
    const entityResult = UserEntity.create(inputData);
    expect(Result.isOk(entityResult)).toBe(true);
    if (Result.isErr(entityResult)) {
      throw new Error('Entity creation failed');
    }

    // Step 2: Save to repository
    const saveResult = await repository.save(entityResult.value);
    expect(Result.isOk(saveResult)).toBe(true);
    if (Result.isErr(saveResult)) {
      throw new Error('Save failed');
    }

    // Step 3: Verify final result
    expect(saveResult.value.id).toBeDefined();
  });
});
```

### Testing Error Propagation

```typescript
describe('UpdateUserUseCase', () => {
  it('propagates validation errors', async () => {
    // Mock repository to return Ok
    mockRepository.findById.mockResolvedValue(
      Result.ok(existingUser)
    );

    // Use case receives invalid update data
    const result = await useCase.execute({
      userId: '123',
      name: ''  // Invalid: empty name
    });

    // ✅ CORRECT: Verify error propagated
    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
      expect(result.error.message).toContain('name');
    }

    // Verify repository save NOT called
    expect(mockRepository.save).not.toHaveBeenCalled();
  });
});
```

---

## Common Testing Scenarios

### Scenario 1: Entity Creation Validation

```typescript
describe('Entity creation', () => {
  // ✅ Test all validation rules
  it.each([
    [{ name: '' }, 'VALIDATION_ERROR', 'name required'],
    [{ name: 'a'.repeat(256) }, 'VALIDATION_ERROR', 'name too long'],
    [{ name: 'Valid' }, 'OK', null],
  ])('validates creation with %o', (input, expectedStatus, expectedError) => {
    const result = Entity.create(input);

    if (expectedStatus === 'OK') {
      expect(Result.isOk(result)).toBe(true);
    } else {
      expect(Result.isErr(result)).toBe(true);
      if (Result.isErr(result)) {
        expect(result.error.code).toBe(expectedStatus);
        if (expectedError) {
          expect(result.error.message).toContain(expectedError);
        }
      }
    }
  });
});
```

### Scenario 2: Use Case with Multiple Failure Points

```typescript
describe('CreateUserUseCase', () => {
  it('handles validation failure', async () => {
    const result = await useCase.execute({ name: '' });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('handles repository failure', async () => {
    mockRepository.save.mockResolvedValue(
      Result.err({ code: 'DATABASE_ERROR', message: 'Failed' })
    );

    const result = await useCase.execute(validInput);

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.code).toBe('DATABASE_ERROR');
    }
  });

  it('succeeds with valid input', async () => {
    mockRepository.save.mockResolvedValue(
      Result.ok(savedUser)
    );

    const result = await useCase.execute(validInput);

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.id).toBeDefined();
    }
  });
});
```

### Scenario 3: Repository Contract Tests

```typescript
describe.each([
  ['Real Implementation', () => new PostgresUserRepository(db)],
  ['Mock Implementation', () => new MockUserRepository()],
])('%s', (name, createRepository) => {
  let repository: UserRepository;

  beforeEach(() => {
    repository = createRepository();
  });

  it('follows save contract', async () => {
    const user = UserEntity.create(validData);
    if (Result.isErr(user)) throw new Error('Setup failed');

    const result = await repository.save(user.value);

    // ✅ Both implementations must return Result
    expect(Result.isOk(result) || Result.isErr(result)).toBe(true);

    // If successful, must have ID
    if (Result.isOk(result)) {
      expect(result.value.id).toBeDefined();
    }
  });

  it('handles errors gracefully', async () => {
    // Force error condition (implementation-specific)
    const result = await repository.save(invalidEntity);

    // ✅ Both implementations must return Err
    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.code).toBeDefined();
      expect(result.error.message).toBeDefined();
    }
  });
});
```

---

## Type Guard Reference

### Available Type Guards

```typescript
// Check if result is Ok
Result.isOk(result): result is Ok<T>

// Check if result is Err
Result.isErr(result): result is Err<E>
```

### Type Narrowing Behavior

```typescript
function processResult(result: Result<User, Error>) {
  // Before type guard: result is Result<User, Error>
  // Cannot access .value or .error

  if (Result.isOk(result)) {
    // Inside this block: result is Ok<User>
    // Can access result.value (type: User)
    console.log(result.value.name);  // ✅ Safe
  }

  if (Result.isErr(result)) {
    // Inside this block: result is Err<Error>
    // Can access result.error (type: Error)
    console.log(result.error.message);  // ✅ Safe
  }
}
```

---

## Quick Reference: Do's and Don'ts

### ✅ DO

```typescript
// Use Result.isOk() type guard
if (Result.isOk(result)) {
  expect(result.value).toBe(expected);
}

// Use Result.isErr() type guard
if (Result.isErr(result)) {
  expect(result.error.code).toBe('ERROR');
}

// Test both branches
expect(Result.isOk(result)).toBe(true);
expect(Result.isErr(result)).toBe(false);

// Throw in setup if unexpected Err
if (Result.isErr(result)) {
  throw new Error('Setup failed');
}
```

### ❌ DON'T

```typescript
// Don't access .ok property
if (result.ok) { ... }  // Type error!

// Don't access .value without type guard
result.value  // Type error!

// Don't use type assertions
(result as any).value  // Unsafe!

// Don't use !Result.isOk() to access .error
if (!Result.isOk(result)) {
  result.error  // Type error! Use Result.isErr()
}
```

---

## Troubleshooting

### Error: "Property 'ok' does not exist on type 'Result'"

**Cause**: Trying to access `.ok` property

**Fix**: Use `Result.isOk(result)` instead
```typescript
// ❌ WRONG
if (result.ok) { ... }

// ✅ CORRECT
if (Result.isOk(result)) { ... }
```

### Error: "Property 'value' does not exist on type 'Result'"

**Cause**: Accessing `.value` without type guard

**Fix**: Use type guard first
```typescript
// ❌ WRONG
expect(result.value).toBe(expected);

// ✅ CORRECT
if (Result.isOk(result)) {
  expect(result.value).toBe(expected);
}
```

### Error: Test fails with "Expected Ok result" but should have passed

**Cause**: Result is actually Err, test setup is wrong

**Debug**:
```typescript
const result = Entity.create(data);
console.log('Result:', result);  // Inspect the result
if (Result.isErr(result)) {
  console.log('Error:', result.error);  // See what went wrong
}
```

**Fix**: Correct your test data to produce Ok result

---

## Summary

1. **Always use type guards**: `Result.isOk()` and `Result.isErr()`
2. **Never access properties directly**: No `.ok`, `.value`, or `.error` without type guard
3. **Narrow types in if blocks**: TypeScript will then allow property access
4. **Test both branches**: Ok and Err cases
5. **Contract tests**: Ensure mocks and real implementations both return Results

Following these patterns ensures type-safe, reliable tests for Result-based codebases.
