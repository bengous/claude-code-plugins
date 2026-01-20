---
description: Initialize testing strategy file for this project
argument-hint: [architecture-type]
allowed-tools:
  - Bash(*:*)
  - Read(*:*)
  - Write(*:*)
  - Glob(*:*)
  - Grep(*:*)
  - AskUserQuestion(*:*)
---

# Setup Testing Strategy

Initialize `.claude/testing-strategy.md` for your project interactively.

---

## Usage

**Interactive mode** (recommended for first time):
```
/setup-testing-strategy
```

**Template mode** (if you know your architecture):
```
/setup-testing-strategy hexagonal
/setup-testing-strategy clean
/setup-testing-strategy layered
```

---

## What This Command Does

This command helps you create a `.claude/testing-strategy.md` file that defines:
- Your architecture type and layer organization
- Coverage targets per layer
- What to test vs skip for each layer
- Testing patterns and frameworks
- Critical testing rules

The layer-testing skill reads this file to understand how to test your project.

---

## Workflow

### Step 1: Check for Existing Strategy

Check if `.claude/testing-strategy.md` already exists:

```bash
if [ -f .claude/testing-strategy.md ]; then
  echo "Strategy file exists"
fi
```

If it exists:
```
⚠️  Testing strategy already exists: .claude/testing-strategy.md

Options:
1. View current strategy
2. Overwrite with new strategy
3. Cancel (keep existing)

What would you like to do?
```

Use AskUserQuestion tool to get choice.

If user chooses "View": Read and display the file, then exit.
If user chooses "Cancel": Exit without changes.
If user chooses "Overwrite": Continue to Step 2.

### Step 2: Detect or Select Architecture

If argument provided (e.g., `hexagonal`):
- Use that architecture template
- Skip to Step 4

If no argument (interactive mode):

Use AskUserQuestion to ask:

```
Question: What architecture pattern does your project use?
Header: Architecture
Options:
  1. Hexagonal (Ports & Adapters)
     Description: Core/domain, application (ports), infrastructure (adapters), boundary

  2. Clean Architecture
     Description: Entities, use cases, interface adapters, frameworks & drivers

  3. Layered (3-tier)
     Description: Presentation, business logic, data access

  4. Custom
     Description: I'll provide my own layer definitions
```

Store selected architecture.

### Step 3: Gather Project Information

Ask follow-up questions based on architecture:

**For all architectures**, ask:

```
Question: What testing framework do you use?
Header: Framework
Options:
  1. Vitest
     Description: Modern, fast, Vite-powered testing

  2. Jest
     Description: Popular, full-featured testing framework

  3. Mocha + Chai
     Description: Flexible testing with separate assertion library

  4. Other
     Description: Specify your test runner
```

```
Question: What do you use for database testing?
Header: Database
Options:
  1. PGlite (in-memory PostgreSQL)
     Description: Fast, real PostgreSQL for testing

  2. SQLite in-memory
     Description: Lightweight in-memory database

  3. Test containers
     Description: Docker containers for testing

  4. Mock/no database
     Description: Don't test with real database
```

**For custom architecture**, additionally ask:

```
Question: What are your layer names? (comma-separated)
Examples: "api,services,repositories" or "controllers,domain,data"
```

### Step 4: Select and Customize Template

Based on architecture selection:

**If hexagonal/clean/layered**: Read template file:
```bash
PLUGIN_ROOT="$(realpath ~/.claude/plugins/marketplaces/*/orchestration 2>/dev/null || echo "${CLAUDE_PLUGIN_ROOT}")"
TEMPLATE="${PLUGIN_ROOT}/skills/layer-testing/templates/examples/${ARCHITECTURE}-strategy.md"
```

**If custom**: Use blank template:
```bash
TEMPLATE="${PLUGIN_ROOT}/skills/layer-testing/templates/testing-strategy-template.md"
```

Read the template file.

### Step 5: Customize Template

Replace placeholders in template with project-specific values:

- `[DATE]` → Current date
- `[hexagonal | clean | layered | custom]` → Selected architecture
- `Vitest|Jest|Mocha` → Selected test framework
- `PGlite|SQLite|Testcontainers` → Selected database approach
- Other placeholders based on user answers

For custom architecture:
- Replace layer name placeholders with user-provided layers
- Keep coverage targets as defaults (user can adjust later)

### Step 6: Write Strategy File

Create `.claude/testing-strategy.md`:

```bash
# Ensure .claude directory exists
mkdir -p .claude

# Write strategy file
cat > .claude/testing-strategy.md << 'EOF'
[Customized template content]
EOF
```

Verify file was created:
```bash
if [ -f .claude/testing-strategy.md ]; then
  echo "✅ Created .claude/testing-strategy.md"
  wc -l .claude/testing-strategy.md
fi
```

### Step 7: Present Summary

Show user what was created:

```
✅ Testing Strategy Created

Location: .claude/testing-strategy.md
Architecture: ${ARCHITECTURE}
Test Framework: ${FRAMEWORK}
Database Testing: ${DATABASE}

Content Summary:
  - ${LAYER_COUNT} layers defined
  - Coverage targets configured
  - Testing patterns included
  - Critical rules specified

Next Steps:

1. Review the file:
   cat .claude/testing-strategy.md

2. Customize for your project:
   - Adjust coverage targets
   - Modify "what to test" patterns
   - Add project-specific rules

3. Start testing:
   /test-layer <module> <layer>

   Or ask naturally:
   "Test the core layer of my auth module"

The layer-testing skill will now use this strategy to guide testing.
```

### Step 8: Offer to Show File

Ask if user wants to see the generated file:

```
Would you like to see the generated testing strategy file?
```

If yes: Read and display `.claude/testing-strategy.md`
If no: Done

---

## Architecture-Specific Templates

### Hexagonal Architecture

**Template**: `skills/layer-testing/templates/examples/hexagonal-strategy.md`

**Layers**:
- Core/Domain (90% target)
- Application (80% target)
- Infrastructure (70% target)
- Boundary (20% target)

**Key patterns**:
- Result<T,E> type guards
- Port/adapter mocking
- Contract tests
- PGlite integration tests

### Clean Architecture

**Template**: `skills/layer-testing/templates/examples/clean-strategy.md`

**Layers**:
- Entities (95% target)
- Use Cases (85% target)
- Interface Adapters (70% target)
- Infrastructure (60% target)

**Key patterns**:
- Enterprise business rules
- Application business rules
- Gateway mocking
- Presenter pattern

### Layered Architecture

**Template**: `skills/layer-testing/templates/examples/layered-strategy.md`

**Layers**:
- Presentation (40% target - prefer E2E)
- Business Logic (85% target)
- Data Access (70% target)

**Key patterns**:
- Service layer mocking
- Repository integration tests
- E2E for presentation

### Custom Architecture

**Template**: `skills/layer-testing/templates/testing-strategy-template.md`

User defines their own layers, coverage targets, and patterns.

---

## Examples

### Example 1: Hexagonal Architecture

```
User: /setup-testing-strategy hexagonal

✅ Testing Strategy Created

Location: .claude/testing-strategy.md
Architecture: Hexagonal (Ports & Adapters)
Test Framework: Vitest
Database Testing: PGlite

Content Summary:
  - 4 layers defined (core, application, infrastructure, boundary)
  - Result<T,E> type guard patterns
  - Contract testing for ports
  - Quality gates specified

Next Steps: Review .claude/testing-strategy.md and customize for your project
```

### Example 2: Interactive Mode

```
User: /setup-testing-strategy

What architecture pattern does your project use?
> Hexagonal (Ports & Adapters)

What testing framework do you use?
> Vitest

What do you use for database testing?
> PGlite (in-memory PostgreSQL)

✅ Creating testing strategy...
✅ Testing Strategy Created

Location: .claude/testing-strategy.md
...
```

### Example 3: Custom Architecture

```
User: /setup-testing-strategy

What architecture pattern does your project use?
> Custom

What are your layer names? (comma-separated)
> api,services,repositories

What testing framework do you use?
> Jest

...

✅ Testing Strategy Created

You've created a custom strategy with:
  - api layer
  - services layer
  - repositories layer

Please edit .claude/testing-strategy.md to:
  - Define coverage targets for each layer
  - Specify what to test vs skip
  - Add testing patterns
```

---

## Troubleshooting

**"Can't find template files"**

**Cause**: Plugin not installed or CLAUDE_PLUGIN_ROOT not set

**Fix**:
```bash
# Check plugin location
ls -la ~/.claude/plugins/marketplaces/*/orchestration/skills/layer-testing/templates/examples/

# Or check if in development
ls -la $CLAUDE_PLUGIN_ROOT/skills/layer-testing/templates/examples/
```

**"Permission denied writing .claude/testing-strategy.md"**

**Cause**: No write permission in current directory

**Fix**: Run from project root where you have write access

**"Strategy file exists but is outdated"**

**Solution**: Choose "Overwrite" option when prompted, or manually edit the file

---

## Notes

- Strategy file is version-controlled (commit to git)
- Team members automatically get strategy when they pull
- Strategy file makes layer-testing skill architecture-agnostic
- You can manually edit the strategy file anytime
- Templates are comprehensive examples - customize for your needs
- Start with a template, then refine based on your project

---

## Related Commands

- `/test-layer <module> <layer>` - Use the strategy to test a layer
- View available templates: `ls ${CLAUDE_PLUGIN_ROOT}/skills/layer-testing/templates/examples/`
