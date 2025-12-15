# Mermaid Diagrams Plugin

A comprehensive skill for creating and editing Mermaid diagrams in Claude Code. This plugin provides extensive syntax references, templates, styling guidance, and software architecture patterns for visualizing technical concepts.

## Features

- **Comprehensive Syntax Support**: All major Mermaid diagram types
  - Flowcharts (process flows, algorithms, decision trees)
  - Sequence diagrams (API interactions, service communication)
  - Class diagrams (object models, domain design)
  - ER diagrams (database schemas, data models)
  - State diagrams (state machines, workflows)
  - C4 diagrams (software architecture)
  - Git graphs (branching strategies)

- **Rich Reference Library**: Quick-access documentation for
  - Common gotchas and syntax errors
  - Styling and theming options
  - Detailed syntax for each diagram type
  - Software architecture patterns

- **Ready-to-Use Templates**: Pre-built, well-commented templates
  - Flowchart template with sections
  - Sequence diagram with best practices
  - Class diagram for domain modeling
  - ER diagram for database schemas

## Usage

This is a skill-based plugin. When you ask Claude Code to create or edit Mermaid diagrams, the skill will be automatically invoked with access to:

- Syntax references for all diagram types
- Common pitfalls and how to avoid them
- Styling and theming options
- Architecture pattern examples
- Professional templates

### Example Requests

```
"Create a sequence diagram showing the authentication flow"
"Help me fix this Mermaid flowchart that's not rendering"
"Generate an ER diagram for a blog database schema"
"Improve this class diagram to show the relationships better"
```

## File Structure

```
mermaid-diagrams/
├── .claude-plugin/
│   └── plugin.json          # Plugin manifest
├── skills/
│   └── mermaid-diagrams/    # Skill files
│       ├── SKILL.md         # Main skill definition
│       ├── assets/          # Templates
│       │   └── templates/
│       │       ├── flowchart-template.md
│       │       ├── sequence-template.md
│       │       ├── class-template.md
│       │       └── er-template.md
│       └── references/      # Documentation
│           ├── gotchas.md   # Common errors
│           ├── styling.md   # Themes & colors
│           ├── patterns.md  # Architecture patterns
│           └── syntax-*.md  # Syntax references
├── README.md                # This file
└── LICENSE                  # MIT License
```

## Reference Materials

The skill includes detailed references that Claude Code can consult when creating diagrams:

- **gotchas.md**: Common syntax errors, reserved keywords, special character handling
- **styling.md**: Themes, colors, and formatting options
- **patterns.md**: Software architecture patterns (microservices, hexagonal, CQRS, etc.)
- **syntax-*.md**: Complete syntax reference for each diagram type

## Templates

All templates are well-organized with:
- Clear section headers using comments
- Best practice examples
- Common patterns for each diagram type
- Extensible structure for complex diagrams

## Best Practices

The skill encourages:
- Clean code organization with liberal comments
- Semantic naming for IDs and labels
- Incremental development (start simple, add complexity)
- Proper handling of special characters
- Accessibility-minded color choices

## Installation

This plugin is part of the bengous-plugins marketplace. Once installed, the skill is automatically available when working with Mermaid diagrams.

## License

MIT License - see LICENSE file for details.

## Keywords

mermaid, diagrams, visualization, documentation, architecture, flowchart, sequence, class-diagram, er-diagram
