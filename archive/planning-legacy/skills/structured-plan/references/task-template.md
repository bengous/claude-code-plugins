# Task Template

Format for breaking plans into atomic, committable tasks.

## Task Format

```markdown
### Task N: [Brief description]

**Files**: List files to create/modify
- `path/to/file.ts` - what changes
- `path/to/other.ts` - what changes

**Verify**: Command or check to confirm the task works
- `npm test path/to/file.test.ts`
- `curl localhost:3000/endpoint`
- Manual: "Open browser, click X, see Y"

**Commit**: Message for this atomic commit
- `feat(scope): description`
```

## Required Fields

| Field | Purpose | Example |
|-------|---------|---------|
| **Files** | Explicit paths, no ambiguity | `src/auth/login.ts` |
| **Verify** | Runnable check or observable outcome | `npm test -- --grep "login"` |
| **Commit** | Conventional commit message | `feat(auth): add login endpoint` |

## Dependency Diagram

Show execution order between tasks.

**Sequential** (use →):
```
Task 1 → Task 2 → Task 3
```

**Parallel** (use commas):
```
Task 4, Task 5, Task 6
```

**Combined**:
```
Task 1 → Task 2 → Task 3
              ↘
         Task 4 → Task 5
Task 6, Task 7              (parallel with above chain)
```

## Example

```markdown
### Task 1: Add config schema

**Files**:
- `src/config/cache.ts` - define CacheConfig type and defaults

**Verify**: `tsc --noEmit` passes

**Commit**: `feat(cache): add configuration schema`

---

### Task 2: Implement cache service

**Files**:
- `src/services/cache.ts` - implement CacheService class
- `src/services/index.ts` - export CacheService

**Verify**: `npm test src/services/cache.test.ts`

**Commit**: `feat(cache): implement cache service`

---

## Task Dependencies

Task 1 → Task 2 → Task 3
Task 4, Task 5 (parallel, after Task 3)
```
