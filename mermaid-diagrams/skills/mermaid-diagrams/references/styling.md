# Mermaid Styling and Theming

Complete guide to styling Mermaid diagrams with themes, colors, and custom styles.

## Themes

Mermaid comes with built-in themes that can be set globally or per diagram.

### Available Themes

```mermaid
%%{init: {'theme':'default'}}%%
flowchart LR
    A --> B
```

**Built-in themes:**
- `default` - Standard blue and grey
- `forest` - Green tones
- `dark` - Dark background
- `neutral` - Greyscale
- `base` - Minimal styling (good for custom styling)

### Setting Theme

**In diagram initialization:**

```mermaid
%%{init: {'theme':'dark'}}%%
flowchart LR
    A[Start] --> B[Process] --> C[End]
```

**Multiple initialization options:**

```mermaid
%%{init: {'theme':'forest', 'themeVariables': { 'primaryColor':'#ff0000'}}}%%
flowchart LR
    A --> B
```

## Theme Variables

Customize theme colors using `themeVariables`:

### Flowchart Variables

```mermaid
%%{init: {
  'theme':'base',
  'themeVariables': {
    'primaryColor':'#BB2528',
    'primaryTextColor':'#fff',
    'primaryBorderColor':'#7C0000',
    'lineColor':'#F8B229',
    'secondaryColor':'#006100',
    'tertiaryColor':'#fff'
  }
}}%%
flowchart LR
    A[Primary] --> B[Secondary]
    B --> C[Tertiary]
```

**Common variables:**
- `primaryColor` - Main node fill color
- `primaryTextColor` - Text color for primary nodes
- `primaryBorderColor` - Border color for primary nodes
- `secondaryColor` - Secondary node color
- `tertiaryColor` - Tertiary node color
- `lineColor` - Connection line color
- `fontSize` - Base font size
- `fontFamily` - Font family

### Sequence Diagram Variables

```mermaid
%%{init: {
  'theme':'base',
  'themeVariables': {
    'actorBkg':'#BB2528',
    'actorBorder':'#7C0000',
    'actorTextColor':'#fff',
    'actorLineColor':'#F8B229',
    'signalColor':'#006100',
    'signalTextColor':'#000',
    'labelBoxBkgColor':'#FFFFDE',
    'labelBoxBorderColor':'#000',
    'labelTextColor':'#000',
    'loopTextColor':'#000',
    'noteBkgColor':'#fff5ad',
    'noteTextColor':'#000',
    'activationBkgColor':'#f4f4f4',
    'activationBorderColor':'#666'
  }
}}%%
sequenceDiagram
    Alice->>Bob: Hello
    Note over Alice,Bob: A note
```

### Class Diagram Variables

```mermaid
%%{init: {
  'theme':'base',
  'themeVariables': {
    'classText':'#000',
    'classBkgColor':'#BB2528',
    'classBorderColor':'#7C0000'
  }
}}%%
classDiagram
    Class01 <|-- Class02
```

## Node-Specific Styling

### Flowchart Node Styles

**Inline styling:**

```mermaid
flowchart LR
    A[Normal]
    B[Styled]
    
    style B fill:#f9f,stroke:#333,stroke-width:4px,color:#000
```

**Style properties:**
- `fill` - Background color
- `stroke` - Border color
- `stroke-width` - Border thickness
- `color` - Text color
- `stroke-dasharray` - Dashed border (e.g., `5 5`)

**Multiple nodes with same style:**

```mermaid
flowchart LR
    A --> B
    A --> C
    A --> D
    
    style B fill:#bbf
    style C fill:#bbf
    style D fill:#bbf
```

### Class Definitions (classDef)

Define reusable styles:

```mermaid
flowchart LR
    A --> B
    A --> C
    
    classDef errorStyle fill:#f66,stroke:#f00,stroke-width:2px,color:#fff
    classDef successStyle fill:#6f6,stroke:#0f0,stroke-width:2px,color:#000
    
    class B errorStyle
    class C successStyle
```

**Apply to multiple nodes:**

```mermaid
flowchart LR
    A --> B
    A --> C
    A --> D
    
    classDef highlight fill:#ff0,stroke:#000,stroke-width:3px
    class B,C,D highlight
```

### Default Styles

Style all nodes of a type:

```mermaid
flowchart LR
    A --> B --> C
    
    classDef default fill:#f9f9f9,stroke:#333,stroke-width:2px
```

## Link Styling

### Basic Link Styles

```mermaid
flowchart LR
    A --> B
    B --> C
    C --> D
    
    linkStyle 0 stroke:#ff0,stroke-width:4px
    linkStyle 1 stroke:#f00,stroke-width:2px,stroke-dasharray:5
    linkStyle 2 stroke:#0f0,stroke-width:3px
```

**Link style properties:**
- `stroke` - Line color
- `stroke-width` - Line thickness
- `stroke-dasharray` - Dashed line pattern
- `fill` - Not used for links

**Link indices** are zero-based in the order they appear.

### Styling Multiple Links

```mermaid
flowchart LR
    A --> B
    B --> C
    C --> D
    D --> E
    
    %% Style links 0, 1, and 2
    linkStyle 0,1,2 stroke:#f00,stroke-width:3px
```

### Default Link Style

```mermaid
flowchart LR
    A --> B --> C --> D
    
    linkStyle default stroke:#666,stroke-width:2px,stroke-dasharray:3
```

## Sequence Diagram Styling

### Actor Styling

Actors can't be styled individually inline, use theme variables or CSS.

### Message Styling

Messages follow the theme but can be influenced by theme variables.

### Activation Boxes

```mermaid
%%{init: {
  'themeVariables': {
    'activationBkgColor':'#f4f4f4',
    'activationBorderColor':'#666'
  }
}}%%
sequenceDiagram
    A->>B: Message
    activate B
    B->>A: Response
    deactivate B
```

## Class Diagram Styling

### Class Boxes

```mermaid
classDiagram
    class MyClass {
        +field: string
        +method()
    }
    
    style MyClass fill:#f9f,stroke:#333,stroke-width:3px
```

### Relationship Lines

Use theme variables for relationship line colors:

```mermaid
%%{init: {
  'themeVariables': {
    'lineColor':'#f00'
  }
}}%%
classDiagram
    ClassA --|> ClassB
    ClassC --* ClassD
```

## State Diagram Styling

### State Styling

```mermaid
stateDiagram-v2
    [*] --> Active
    Active --> Inactive
    Inactive --> [*]
    
    style Active fill:#6f6,stroke:#0f0,stroke-width:3px
    style Inactive fill:#f66,stroke:#f00,stroke-width:3px
```

## ER Diagram Styling

ER diagrams have limited styling options. Use theme variables:

```mermaid
%%{init: {
  'themeVariables': {
    'primaryColor':'#BB2528',
    'lineColor':'#F8B229'
  }
}}%%
erDiagram
    CUSTOMER ||--o{ ORDER : places
```

## C4 Diagram Styling

C4 diagrams have built-in styling by element type. Use theme for global colors:

```mermaid
%%{init: {
  'theme':'base',
  'themeVariables': {
    'primaryColor':'#1168bd',
    'primaryTextColor':'#fff',
    'primaryBorderColor':'#0b4884'
  }
}}%%
C4Context
    Person(user, "User")
    System(sys, "System")
```

## Git Graph Styling

Git graphs follow the theme. Limited custom styling available:

```mermaid
%%{init: {
  'theme':'base',
  'themeVariables': {
    'git0':'#f00',
    'git1':'#0f0',
    'git2':'#00f'
  }
}}%%
gitGraph
    commit
    branch develop
    commit
    checkout main
    commit
```

## Advanced Styling Patterns

### Conditional Styling Pattern

Create classes for different states:

```mermaid
flowchart LR
    Start --> Processing
    Processing --> Success
    Processing --> Error
    
    classDef running fill:#ff0,stroke:#f90,stroke-width:2px
    classDef success fill:#6f6,stroke:#0f0,stroke-width:2px
    classDef error fill:#f66,stroke:#f00,stroke-width:2px
    
    class Processing running
    class Success success
    class Error error
```

### Semantic Color Schemes

**Standard semantic colors:**

```mermaid
flowchart LR
    Info --> Warning
    Warning --> Error
    Error --> Success
    
    classDef info fill:#d1ecf1,stroke:#0c5460,stroke-width:2px
    classDef warning fill:#fff3cd,stroke:#856404,stroke-width:2px
    classDef error fill:#f8d7da,stroke:#721c24,stroke-width:2px
    classDef success fill:#d4edda,stroke:#155724,stroke-width:2px
    
    class Info info
    class Warning warning
    class Error error
    class Success success
```

### Architecture Layer Styling

For software architecture diagrams:

```mermaid
flowchart TB
    Client[Client Layer]
    API[API Layer]
    Business[Business Logic]
    Data[Data Layer]
    
    Client --> API
    API --> Business
    Business --> Data
    
    classDef presentation fill:#e3f2fd,stroke:#1976d2,stroke-width:2px
    classDef application fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px
    classDef domain fill:#e8f5e9,stroke:#388e3c,stroke-width:2px
    classDef infrastructure fill:#fff3e0,stroke:#f57c00,stroke-width:2px
    
    class Client presentation
    class API application
    class Business domain
    class Data infrastructure
```

### Emphasis and Hierarchy

Use opacity and size to show hierarchy:

```mermaid
flowchart TB
    Main[Main Process]
    Sub1[Sub Process 1]
    Sub2[Sub Process 2]
    Detail1[Detail A]
    Detail2[Detail B]
    
    Main --> Sub1
    Main --> Sub2
    Sub1 --> Detail1
    Sub2 --> Detail2
    
    style Main fill:#1976d2,stroke:#0d47a1,stroke-width:4px,color:#fff
    style Sub1 fill:#42a5f5,stroke:#1976d2,stroke-width:3px,color:#fff
    style Sub2 fill:#42a5f5,stroke:#1976d2,stroke-width:3px,color:#fff
    style Detail1 fill:#bbdefb,stroke:#1976d2,stroke-width:2px
    style Detail2 fill:#bbdefb,stroke:#1976d2,stroke-width:2px
```

## Best Practices for Styling

### 1. Use Consistent Color Schemes

Define your palette upfront:

```mermaid
flowchart LR
    %% Color Palette:
    %% Primary: #1976d2
    %% Secondary: #388e3c
    %% Accent: #f57c00
    %% Error: #d32f2f
    
    A --> B
    
    classDef primary fill:#1976d2,stroke:#0d47a1,stroke-width:2px,color:#fff
    classDef secondary fill:#388e3c,stroke:#1b5e20,stroke-width:2px,color:#fff
```

### 2. Define Styles Before Applying

Keep style definitions together:

```mermaid
flowchart LR
    %% Node definitions
    A --> B --> C
    
    %% Style definitions
    classDef important fill:#f00,stroke:#900,stroke-width:3px,color:#fff
    classDef normal fill:#f9f9f9,stroke:#333,stroke-width:2px
    
    %% Style applications
    class A important
    class B,C normal
```

### 3. Use Semantic Names

```mermaid
flowchart LR
    A --> B
    
    classDef errorState fill:#f66,stroke:#f00,stroke-width:2px
    classDef successState fill:#6f6,stroke:#0f0,stroke-width:2px
    
    %% Not: classDef red fill:#f66
    %% Not: classDef green fill:#6f6
```

### 4. Consider Accessibility

- Use sufficient contrast (WCAG AA minimum)
- Don't rely solely on color to convey meaning
- Test with colorblind-friendly palettes

```mermaid
flowchart LR
    A[Step 1] --> B[Step 2]
    
    %% Good contrast
    classDef step fill:#0077be,stroke:#003d5c,stroke-width:2px,color:#fff
    class A,B step
```

### 5. Keep It Simple

Don't over-style. Clean diagrams are more readable:

```mermaid
%% ❌ TOO MUCH
flowchart LR
    A[Node]
    style A fill:#f9f,stroke:#333,stroke-width:4px,color:#f00,stroke-dasharray:5 5

%% ✅ CLEAN
flowchart LR
    B[Node]
    style B fill:#f9f,stroke:#333,stroke-width:2px
```

### 6. Theme First, Then Customize

Start with a theme and customize only what you need:

```mermaid
%%{init: {'theme':'base'}}%%
flowchart LR
    A --> B --> C
    
    %% Only customize what's different
    style B fill:#f9f
```

## Styling Checklist

- [ ] Choose appropriate base theme
- [ ] Define color palette upfront
- [ ] Use semantic class names
- [ ] Group style definitions together
- [ ] Test contrast and readability
- [ ] Keep styling minimal and purposeful
- [ ] Document color meanings if needed
