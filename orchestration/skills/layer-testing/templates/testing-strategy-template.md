# Testing Strategy

> This file defines testing ideology and patterns for this project.
> Updated: [DATE]
> Architecture: [hexagonal | clean | layered | custom]

---

## Architecture Overview

**Brief description of your architecture:**
[Describe your project's architectural pattern and how it's organized]

**Module organization:**
```
src/
├── modules/
│   ├── [module-1]/
│   │   ├── [layer-1]/
│   │   ├── [layer-2]/
│   │   └── [layer-3]/
│   └── [module-2]/
│       └── ...
```

---

## Layer Definitions

Define each layer in your architecture with testing guidelines.

### [Layer Name 1] (e.g., Core, Domain, Entities)

- **Path pattern**: `src/modules/*/[layer-name]/**`
- **Coverage target**: XX%
- **Philosophy**: [What this layer does and why we test it]

**What to test**:
- [Type of file/component 1] - [reason]
- [Type of file/component 2] - [reason]
- [Type of file/component 3] - [reason]

**What to skip**:
- [Type of file/component to skip 1] - [reason]
- [Type of file/component to skip 2] - [reason]

**Testing approach**:
- [Unit tests | Integration tests | Contract tests]
- [Mocking strategy for this layer]
- [Specific patterns or frameworks]

**Examples**:
- Reference test: `src/modules/[example-module]/[layer]/__tests__/[Example].test.ts`

---

### [Layer Name 2] (e.g., Application, Use Cases)

- **Path pattern**: `src/modules/*/[layer-name]/**`
- **Coverage target**: XX%
- **Philosophy**: [What this layer does and why we test it]

**What to test**:
- [Component types]

**What to skip**:
- [Component types]

**Testing approach**:
- [Approach description]

---

### [Layer Name 3] (e.g., Infrastructure, Adapters)

- **Path pattern**: `src/modules/*/[layer-name]/**`
- **Coverage target**: XX%
- **Philosophy**: [What this layer does and why we test it]

**What to test**:
- [Component types]

**What to skip**:
- [Component types]

**Testing approach**:
- [Approach description]

---

## Testing Patterns

### [Pattern Name 1] (e.g., Entity Validation Tests)

**When to use**: [Describe when this pattern applies]

**Pattern**:
```typescript
// Example test structure
describe('[ComponentName]', () => {
  it('validates [behavior]', () => {
    // Arrange
    const input = { ... };

    // Act
    const result = Component.method(input);

    // Assert
    expect(result).toBe(expected);
  });
});
```

---

### [Pattern Name 2] (e.g., Mock Strategy)

**When to use**: [Describe when this pattern applies]

**Pattern**:
```typescript
// Example mock structure
const mockDependency = {
  method: vi.fn().mockResolvedValue(expectedResult)
};
```

---

## Framework & Tools

**Test runner**: [e.g., Vitest, Jest, Mocha]
```bash
# Run tests
[command]

# Run with coverage
[command --coverage]
```

**Database testing**: [e.g., PGlite, in-memory DB, Docker]
**Mocking library**: [e.g., Vitest mocks, jest.fn(), Sinon]
**Assertion library**: [e.g., expect, chai, should]
**Coverage tool**: [e.g., c8, Istanbul, built-in]

**Test file location**:
- Option 1: Co-located in `__tests__/` subdirectories
- Option 2: Separate `tests/` directory mirroring `src/`
- Option 3: [Your pattern]

**Test file naming**: [e.g., `*.test.ts`, `*.spec.ts`, `*-test.ts`]

---

## Critical Rules

### ✅ MUST DO

- [Rule 1 - e.g., "Use Result.isOk() type guards, not .ok property"]
- [Rule 2 - e.g., "Mock at architectural boundaries (ports)"]
- [Rule 3 - e.g., "Test happy path + error cases + edge cases"]
- [Rule 4 - e.g., "Create contract tests for all port implementations"]
- [Rule 5 - e.g., "Place mocks in [specific location]"]

### ❌ MUST NOT DO

- [Anti-pattern 1 - e.g., "Modify production code in test commits"]
- [Anti-pattern 2 - e.g., "Mock domain logic"]
- [Anti-pattern 3 - e.g., "Test framework boilerplate"]
- [Anti-pattern 4 - e.g., "Skip error case testing"]
- [Anti-pattern 5 - e.g., "Use .only() or .skip() in committed tests"]

---

## Project-Specific Patterns

### [Pattern/Idiom 1]

**Description**: [What this pattern is]

**Example**:
```typescript
// Code example
```

**Testing guideline**: [How to test this pattern]

---

### [Pattern/Idiom 2]

**Description**: [What this pattern is]

**Example**:
```typescript
// Code example
```

**Testing guideline**: [How to test this pattern]

---

## Edge Cases & Special Scenarios

### Scenario 1: [e.g., "Async Operations"]

**Guideline**: [How to handle this]

**Example**:
```typescript
// Test example
```

---

### Scenario 2: [e.g., "Error Boundaries"]

**Guideline**: [How to handle this]

---

## Coverage Philosophy

**Overall target**: [XX]%

**Layer-specific rationale**:
- [Layer 1]: [XX]% because [reason]
- [Layer 2]: [XX]% because [reason]
- [Layer 3]: [XX]% because [reason]

**When to accept lower coverage**:
- [Scenario 1 - e.g., "Complex integration logic requiring external services"]
- [Scenario 2 - e.g., "Framework boilerplate (exclude from coverage)"]
- [Scenario 3 - e.g., "Defensive code for edge cases (document as unreachable)"]

**When coverage isn't enough**:
Coverage measures lines executed, not quality. Also ensure:
- [Quality metric 1 - e.g., "Test both success and error paths"]
- [Quality metric 2 - e.g., "Test edge cases and boundaries"]
- [Quality metric 3 - e.g., "Assertions verify behavior, not implementation"]

---

## Team Conventions

**Test data factories**: [Location and pattern]
**Setup helpers**: [Location and pattern]
**Shared mocks**: [Location and pattern]
**Test utilities**: [Location and pattern]

---

## Version History

- **[DATE]**: Initial testing strategy
- **[DATE]**: Added [layer/pattern]
- **[DATE]**: Updated coverage targets based on [reason]

---

## Resources

- Architecture documentation: [link or path]
- Testing best practices: [link or path]
- Framework documentation: [link]
- Team testing guidelines: [link or path]

---

## Notes

- This file is version-controlled and shared with the team
- Update this file when adding new layers or changing testing approach
- The layer-testing skill reads this file to determine what/how to test
- Each project customizes this template for their specific needs
