---
name: mermaid-diagrams
description: Create Mermaid diagrams. ONLY use when user explicitly says "Mermaid". NOT for general diagrams, schemas, ASCII art, or wireframes.
---

# Mermaid Diagrams Skill

This skill helps create clean, well-organized Mermaid diagrams for software engineering and architecture visualization.

## When to Use This Skill

Use this skill when the user wants to:
- **Create** new Mermaid diagrams
- **Edit** existing Mermaid diagrams
- **Fix** broken or incorrect diagram syntax
- **Improve** diagram organization or readability
- **Visualize** software architecture or technical concepts

**Do not use this skill for:**
- Simply reading or interpreting existing diagrams (no skill needed)
- Non-technical diagrams (organizational charts, mind maps without code context)

## Available Diagram Types

This skill supports all major Mermaid diagram types for software engineering:

1. **Flowcharts** - Process flows, algorithms, decision trees
2. **Sequence Diagrams** - API interactions, service communication, workflows
3. **Class Diagrams** - Object models, domain design, relationships
4. **ER Diagrams** - Database schemas, data models
5. **State Diagrams** - State machines, workflow states, lifecycle
6. **C4 Diagrams** - Software architecture (context, container, component)
7. **Git Graphs** - Branching strategies, version control workflows

## Core References

### Quick Reference Priority

When creating or editing diagrams, consult references in this order:

**For all diagrams first:**
1. **`references/gotchas.md`** - Common errors, special characters, reserved keywords
2. **`references/styling.md`** - Themes, colors, formatting

**Then consult the specific syntax reference:**
- `references/syntax-flowchart.md`
- `references/syntax-sequence.md`
- `references/syntax-class.md`
- `references/syntax-er.md`
- `references/syntax-state.md`
- `references/syntax-c4.md`
- `references/syntax-git.md`

**For architectural patterns:**
- `references/patterns.md` - Common software architecture patterns

### When to Load References

**Always load gotchas.md when:**
- Creating complex diagrams
- Fixing syntax errors
- Dealing with special characters or reserved words

**Load styling.md when:**
- User requests specific colors or themes
- Creating presentation-quality diagrams
- Need to emphasize specific elements

**Load specific syntax reference when:**
- Creating a diagram type for the first time
- User asks about specific features
- Need to verify correct syntax

**Load patterns.md when:**
- Visualizing software architecture
- User mentions specific patterns (microservices, hexagonal, CQRS, etc.)
- Creating system design diagrams

## Templates

Pre-built, well-commented templates are available in `assets/templates/`:

- `flowchart-template.md` - Organized flowchart with sections
- `sequence-template.md` - Sequence diagram with best practices
- `class-template.md` - Domain model class diagram
- `er-template.md` - Database schema ER diagram

**Use templates when:**
- Starting a new complex diagram
- User wants a well-organized structure
- Creating diagrams that will grow over time

## Best Practices for Diagram Creation

### 1. Clean Code Organization

Use the same principles as code:
- **Comment liberally** - Use `%%` to explain sections
- **Group related items** - Keep related nodes/classes together
- **Separate concerns** - Define structure first, styling last
- **Use descriptive names** - Make IDs and labels meaningful

**Example:**
```mermaid
flowchart TB
    %% =================================================================
    %% USER AUTHENTICATION FLOW
    %% =================================================================
    
    %% -----------------------------------------------------------------
    %% Entry Point
    %% -----------------------------------------------------------------
    Start[User enters credentials]
    
    %% -----------------------------------------------------------------
    %% Validation
    %% -----------------------------------------------------------------
    Validate[Validate input format]
    CheckDB{Credentials valid?}
    
    %% ... rest of diagram
```

### 2. Make Diagrams Navigable

For large diagrams:
- Use clear section headers in comments
- Group logically related elements
- Keep consistent indentation in the code
- Add blank lines between sections

**Structure pattern:**
```
%% Section 1: Definition
[define elements]

%% Section 2: Connections
[define relationships]

%% Section 3: Styling
[define styles]
```

### 3. Handle Complexity

When diagrams get large:
- Break into multiple smaller diagrams
- Use subgraphs for logical grouping
- Link between diagrams with notes
- Consider creating an overview diagram

### 4. Avoid Common Pitfalls

Before finalizing any diagram, check:
- [ ] No reserved keywords as node IDs
- [ ] Special characters properly escaped or quoted
- [ ] All brackets/parens balanced
- [ ] All blocks (subgraph, loop, alt) properly closed
- [ ] Unique IDs for all elements
- [ ] Consistent quote style throughout

## Workflow for Creating Diagrams

### Step 1: Understand Requirements
- What concept needs visualization?
- Which diagram type is most appropriate?
- What's the target audience?

### Step 2: Choose Diagram Type
- **Process/Algorithm** → Flowchart
- **Time-based interactions** → Sequence diagram
- **Object relationships** → Class diagram
- **Data model** → ER diagram
- **State management** → State diagram
- **System architecture** → C4 diagrams
- **Git workflow** → Git graph

### Step 3: Start Simple
Begin with basic structure:
```mermaid
flowchart LR
    A --> B
    B --> C
```

### Step 4: Add Details Incrementally
- Add more nodes/relationships
- Add labels and descriptions
- Group into subgraphs if needed
- Add comments for clarity

### Step 5: Apply Styling (Optional)
- Choose appropriate theme
- Add colors for semantic meaning
- Highlight important elements
- Ensure accessibility

### Step 6: Review and Refine
- Test the diagram renders correctly
- Check for syntax errors
- Verify it communicates the intended message
- Add comments for future maintainability

## Quick Syntax Reminders

### Escaping Special Characters
```mermaid
%% Use quotes for special characters
A["Function with (parentheses)"]
B["Text with [brackets]"]

%% Or use HTML entities
C[getData#40;#41;]  %% getData()
```

### Common Relationship Patterns

**Flowcharts:**
- `-->` solid arrow
- `-.->` dotted arrow
- `==>` thick arrow

**Class diagrams:**
- `<|--` inheritance
- `*--` composition
- `o--` aggregation
- `-->` association
- `..>` dependency

**ER diagrams:**
- `||--||` one-to-one
- `||--o{` one-to-many
- `}o--o{` many-to-many

## Common Use Cases

### API Documentation
Use sequence diagrams to show request/response flows:
```mermaid
sequenceDiagram
    Client->>API: POST /users
    API->>Database: INSERT user
    Database-->>API: User created
    API-->>Client: 201 Created
```

### Database Schema
Use ER diagrams with full attribute details:
```mermaid
erDiagram
    USER {
        uuid id PK
        string email UK
    }
    ORDER {
        uuid id PK
        uuid user_id FK
    }
    USER ||--o{ ORDER : places
```

### System Architecture
Use C4 diagrams for different abstraction levels:
```mermaid
C4Context
    Person(user, "User")
    System(sys, "System")
    Rel(user, sys, "Uses")
```

### Process Documentation
Use flowcharts with clear decision points:
```mermaid
flowchart TB
    Start --> Check{Valid?}
    Check -->|Yes| Process
    Check -->|No| Error
```

## Troubleshooting

### Diagram Won't Render

1. Check for unbalanced quotes or brackets
2. Look for reserved keywords as IDs
3. Verify all blocks are closed (end statements)
4. Check for special characters - escape them
5. Ensure proper syntax for diagram type

### Common Error Fixes

**"Parse error"**
→ Check syntax matches diagram type

**"Syntax error in text"**
→ Escape special characters or use quotes

**Blank output**
→ Check browser console, usually invalid syntax

**Wrong appearance**
→ Verify correct diagram type declaration

## Tips for AI-Assisted Diagram Editing

When editing existing diagrams:
1. Preserve the original structure and organization
2. Keep existing comments - they're valuable context
3. Maintain consistent naming conventions
4. Don't break working syntax to "improve" it
5. Test after each major change

When creating new diagrams:
1. Start with a template if appropriate
2. Build incrementally - test as you go
3. Add comments explaining the purpose
4. Use semantic styling (not just decoration)
5. Consider maintainability

## Integration with Development Workflow

Mermaid diagrams work great in:
- **Documentation** - README.md, docs/ folder
- **PRs/Issues** - Visualize changes or problems
- **ADRs** - Architecture Decision Records
- **Wikis** - Team knowledge base
- **Presentations** - Export as images

They can be version controlled, reviewed, and updated like code!

## Remember

- **Start simple** - Add complexity incrementally
- **Comment well** - Future you will thank you
- **Test often** - Verify syntax as you build
- **Use templates** - Don't reinvent the wheel
- **Consult gotchas** - Avoid common errors
- **Stay organized** - Group and section your diagrams

The goal is to create diagrams that are:
- **Clear** - Communicate effectively
- **Maintainable** - Easy to update later
- **Navigable** - Easy to understand the code
- **Correct** - Render without errors
