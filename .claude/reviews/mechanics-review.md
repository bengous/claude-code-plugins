# Rules Mechanics Review

## Summary

**PASS WITH NOTES** - The rules implementation is functionally correct and follows documentation conventions. Minor issues found: one glob pattern gap for `marketplace.json`, and unconditional rule comments use non-standard syntax that may confuse readers.

## Findings

### Frontmatter Syntax

All frontmatter is syntactically valid YAML:

| File | Syntax | Notes |
|------|--------|-------|
| `01-behavioral.md` | Valid | Uses comment instead of empty `paths:` |
| `02-simplicity.md` | Valid | Uses comment instead of empty `paths:` |
| `03-component-selection.md` | Valid | Uses comment instead of empty `paths:` |
| `agents/agent-patterns.md` | Valid | Single string pattern |
| `skills/skill-patterns.md` | Valid | Array of two patterns |
| `commands/command-patterns.md` | Valid | Single string pattern |
| `scripts/script-patterns.md` | Valid | Single string pattern |
| `hooks/hook-patterns.md` | Valid | Single string pattern |
| `publishing/marketplace.md` | Valid | Array of two patterns |

**Note on unconditional rules:** The current implementation uses a YAML comment (`# No paths: field = always loaded`) inside the frontmatter. While this works (rules without `paths:` are unconditional), the documentation shows unconditional rules should simply have no `paths:` key at all - the comment is unnecessary and non-standard. Consider either:
- Removing the frontmatter entirely for unconditional rules
- Or leaving empty frontmatter (`---\n---`)

### Conditional vs Unconditional Rules

The categorization is appropriate:

**Unconditional (correct):**
- `01-behavioral.md` - Behavioral rules apply to all plugin work
- `02-simplicity.md` - Simplicity principle applies universally
- `03-component-selection.md` - Component selection guidance applies to all decisions

**Conditional (correct):**
- `agents/agent-patterns.md` - Only relevant when working on agent files
- `skills/skill-patterns.md` - Only relevant when working on skill files
- `commands/command-patterns.md` - Only relevant when working on command files
- `scripts/script-patterns.md` - Only relevant when working on script files
- `hooks/hook-patterns.md` - Only relevant when working on hook files
- `publishing/marketplace.md` - Only relevant when working on marketplace/plugin manifests

### Glob Pattern Coverage

**Working correctly:**

| Rule | Pattern | Matches Found |
|------|---------|---------------|
| `agent-patterns.md` | `**/agents/**/*.md` | `orchestration/agents/*.md` (4 files) |
| `skill-patterns.md` | `**/skills/**/*.md`, `**/SKILL.md` | `orchestration/skills/layer-testing/SKILL.md` + references |
| `command-patterns.md` | `**/commands/**/*.md` | Multiple plugins have `commands/*.md` files |
| `script-patterns.md` | `**/scripts/**` | Scripts across `git-tools/`, `orchestration/`, `claude-meta-tools/` |
| `publishing/marketplace.md` | `**/plugin.json` | `*.claude-plugin/plugin.json` files in each plugin |

**Gap identified:**

| Rule | Pattern | Issue |
|------|---------|-------|
| `publishing/marketplace.md` | `marketplace.json` | Pattern without `**/` prefix only matches root. Actual file is at `.claude-plugin/marketplace.json` |

The `marketplace.json` pattern in `publishing/marketplace.md` will NOT match the actual file at `.claude-plugin/marketplace.json`. Should be `**/marketplace.json` to match anywhere in the tree.

**Potential over-matching (minor):**

- `**/hooks/**` matches `.git/hooks/` files (git hook samples) which is unintended but harmless since those aren't `.md` files and won't typically be edited
- `**/scripts/**` could match files in `_docs/` directory, but the documentation rules should handle that separately

### Load Order

The `01-`, `02-`, `03-` numbering is appropriate:

1. **01-behavioral.md** - "Before You Do Anything" rules come first (investigate before implementing)
2. **02-simplicity.md** - Core principle established second (don't over-engineer)
3. **03-component-selection.md** - Component selection guidance third (choose the right tool)

This ordering makes semantic sense: first establish investigation habits, then establish simplicity principle, then provide the decision framework.

Conditional rules in subdirectories don't have numbered prefixes, which is correct - they load based on path matching, not file order.

### File Organization

The structure follows documentation best practices:

```
.claude/rules/
├── 01-behavioral.md      # Unconditional, numbered for order
├── 02-simplicity.md      # Unconditional, numbered for order
├── 03-component-selection.md  # Unconditional, numbered for order
├── agents/               # Domain-specific subdirectory
│   └── agent-patterns.md
├── commands/
│   └── command-patterns.md
├── hooks/
│   └── hook-patterns.md
├── publishing/
│   └── marketplace.md
├── scripts/
│   └── script-patterns.md
└── skills/
    └── skill-patterns.md
```

**Strengths:**
- Clear separation between unconditional (root) and conditional (subdirectories)
- Descriptive subdirectory names match component types
- Single focused file per topic
- Automatic recursive discovery will find all files

## Recommendations

1. **Fix marketplace.json glob pattern** (Priority: High)

   In `/home/b3ngous/projects/claude-plugins/.claude/rules/publishing/marketplace.md`, change:
   ```yaml
   paths:
     - "marketplace.json"        # Only matches root
     - "**/plugin.json"
   ```
   To:
   ```yaml
   paths:
     - "**/marketplace.json"     # Matches anywhere
     - "**/plugin.json"
   ```

2. **Simplify unconditional rule frontmatter** (Priority: Low)

   The comment-based approach works but is non-standard. Consider either:
   - Remove frontmatter entirely from unconditional rules
   - Use empty frontmatter (`---\n---`)

   Current:
   ```yaml
   ---
   # No paths: field = always loaded (unconditional)
   ---
   ```

   Recommended (either option):
   ```markdown
   # Before You Do Anything
   ...
   ```
   Or:
   ```yaml
   ---
   ---

   # Before You Do Anything
   ```

3. **Consider excluding patterns** (Priority: Optional)

   If `_docs/` directory content triggering rules becomes an issue, consider whether a `.claude/rules/` exclude mechanism is available, or document that `_docs/` is a reference archive not subject to plugin rules.
