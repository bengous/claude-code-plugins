# Code Quality Plugin

Code quality and cleanup commands for maintaining clean, maintainable code.

## Commands

### `/code-quality:clean-comments`

Remove useless comments from files you've touched, keeping only meaningful ones.

**Usage:**
```bash
/code-quality:clean-comments              # Clean comments in git-modified files
/code-quality:clean-comments src/**/*.ts  # Clean comments in specific files
```

**What gets removed:**
- Obvious comments that restate the code
- Commented-out code blocks
- Redundant documentation
- Noise comments with no value

**What gets kept:**
- Explanations of non-trivial code logic
- Documentation of "magic" constants/numbers
- Interface/type/contract definitions
- Complex algorithm explanations
- Important architectural notes

**Example:**

Before:
```typescript
// Initialize the counter
let counter = 0;

// Loop through items
items.forEach(item => {
  // Increment counter
  counter++;

  // Magic number for performance tuning - controls batch size
  if (counter % 100 === 0) {
    flush();
  }
});
```

After:
```typescript
let counter = 0;

items.forEach(item => {
  counter++;

  // Batch size of 100 optimizes memory usage vs throughput
  if (counter % 100 === 0) {
    flush();
  }
});
```

## Philosophy

Good code should be self-documenting. Comments should only exist when:
1. The code does something non-obvious that can't be refactored to be clearer
2. There's important context (like why a magic number has that specific value)
3. You're defining a contract/interface that others will implement

Everything else is noise that becomes stale and misleading over time.

## Installation

This plugin is part of the `bengolea-plugins` marketplace.

Add to `.claude/settings.json`:
```json
{
  "enabledPlugins": ["code-quality@bengolea-plugins"]
}
```

Or install via command:
```bash
/plugin install code-quality@bengolea-plugins
```

## License

MIT
