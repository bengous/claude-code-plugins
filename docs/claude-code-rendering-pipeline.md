# Claude Code Rendering Pipeline

A comprehensive analysis of how Claude Code renders output to the terminal, documenting what formatting features work, what doesn't, and practical techniques for rich terminal output.

## Overview

Claude Code uses [Ink](https://github.com/vadimdemedes/ink) (a React renderer for the terminal) to build its TUI interface. However, Claude's text output doesn't have direct access to inject Ink/React components. Instead, output flows through a markdown parser before being rendered by Ink.

```
┌─────────────────────────────────────────────────────────────────┐
│                     Rendering Pipeline                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   Claude Output (text)                                          │
│         │                                                       │
│         ▼                                                       │
│   ┌─────────────┐                                               │
│   │  Markdown   │  ← Parses formatting, strips HTML-like tags   │
│   │   Parser    │                                               │
│   └──────┬──────┘                                               │
│          │                                                      │
│          ▼                                                      │
│   ┌─────────────┐                                               │
│   │    Ink      │  ← Renders to terminal with React components  │
│   │  Renderer   │                                               │
│   └──────┬──────┘                                               │
│          │                                                      │
│          ▼                                                      │
│   Terminal Output (with colors, formatting)                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Key insight:** We cannot inject Ink components directly. Our "attack surface" for visual output is limited to what the markdown parser supports plus raw Unicode characters.

## Markdown Features

### Working Features

| Feature          | Syntax                    | Notes                         |
| ---------------- | ------------------------- | ----------------------------- |
| **Bold**         | `**text**` or `__text__`  | Both syntaxes work            |
| _Italic_         | `*text*` or `_text_`      | Both syntaxes work            |
| `Inline code`    | `` `code` ``              | Renders with distinct styling |
| Headers          | `# H1`, `## H2`, `### H3` | All levels work               |
| Tables           | Standard markdown tables  | Full support                  |
| Bullet lists     | `- item` or `* item`      | Works                         |
| Numbered lists   | `1. item`                 | Works                         |
| Blockquotes      | `> text`                  | Renders as italic gray text   |
| Horizontal rules | `---`                     | Works                         |
| Links            | `[text](url)`             | Blue, clickable in terminal   |
| Code blocks      | ` ```language `           | With syntax highlighting      |

### Non-Working Features

| Feature                        | Syntax                  | Behavior                                 |
| ------------------------------ | ----------------------- | ---------------------------------------- |
| ~~Strikethrough~~              | `~~text~~`              | Shows literal `~~` characters            |
| Images                         | `![alt](url)`           | Shows as plain text (no image rendering) |
| HTML entities                  | `&lt;` `&#x2588;`       | Renders literally, not decoded           |
| Nested markdown in code blocks | Any markdown inside ``` | Preserved literally (expected behavior)  |
| Empty links                    | `[text]()`              | May be stripped/hidden                   |

## Syntax Highlighting

Code blocks support syntax highlighting for many languages via a built-in highlighter (likely Shiki or Prism).

### Confirmed Working Languages

| Language   | Fence                          | Color Patterns                          |
| ---------- | ------------------------------ | --------------------------------------- |
| JavaScript | ` ```javascript ` or ` ```js ` | Keywords blue, strings red, etc.        |
| TypeScript | ` ```typescript ` or ` ```ts ` | Interface/type keywords blue            |
| Python     | ` ```python `                  | Keywords colored                        |
| HTML       | ` ```html `                    | Tags blue, attributes green, values red |
| CSS        | ` ```css `                     | Properties colored                      |
| Bash       | ` ```bash `                    | Commands green, strings red             |
| JSON       | ` ```json `                    | Keys green, strings red, booleans blue  |

### Non-Working Languages

| Language | Fence         | Behavior                    |
| -------- | ------------- | --------------------------- |
| Liquid   | ` ```liquid ` | No highlighting (all white) |

## Unicode Support

Unicode characters pass through the rendering pipeline unchanged, enabling rich visual output.

### Box Drawing Characters

Standard box drawing works well for diagrams:

```
┌──────────────┐
│   Content    │
├──────────────┤
│   More       │
└──────────────┘
```

**Character reference:**

- Corners: `┌ ┐ └ ┘`
- Lines: `─ │`
- Intersections: `├ ┤ ┬ ┴ ┼`
- Rounded: `╭ ╮ ╰ ╯`
- Double: `║ ═ ╔ ╗ ╚ ╝`
- Arrows: `← → ↑ ↓ ► ◄ ▲ ▼`

### Block Elements

Useful for progress bars, gradients, and visual emphasis:

```
█▓▒░  (full to light blocks)
▄▀    (half blocks)
▌▐    (side half blocks)
```

**Gradient example:** `█▓▒░ intensity ░▒▓█`

### Braille Patterns

Braille characters (U+2800 to U+28FF) enable "high-resolution" pixel art in the terminal. Each character is a 2x4 dot matrix.

**Important:** Terminal characters are typically ~2:1 height:width ratio. Compensate by making braille art wider than tall for proper proportions.

**Example - Circle (aspect-ratio compensated):**

```
⠀⠀⠀⠀⠀⣀⣀⣀⣀⣀⠀⠀⠀⠀⠀
⠀⠀⣠⠶⠋⠁⠀⠀⠀⠈⠙⠶⣄⠀⠀
⠀⡼⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⢧⠀
⠀⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⠀
⠀⠹⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⠏⠀
⠀⠀⠈⠛⠦⣄⣀⣀⣀⣠⠴⠛⠁⠀⠀
```

## Injection Attempts (What Doesn't Work)

### ANSI Escape Codes

Raw ANSI codes are escaped/sanitized:

- Input: `\x1b[31mRed text\x1b[0m`
- Output: Literal `\x1b[31mRed text\x1b[0m` (no color)

### JSX/Ink Components

JSX-like syntax is treated as HTML and stripped:

- Input: `<Box borderStyle="round"><Text color="green">Hello</Text></Box>`
- Output: `Hello` (tags stripped, content preserved)

This is standard markdown behavior for unknown HTML tags.

### HTML Entities

HTML entities are not decoded:

- Input: `&lt;Box&gt; &#x2588;`
- Output: Literal `&lt;Box&gt; &#x2588;`

## Practical Applications

### Rich Diagrams (Outside Code Blocks)

Combine markdown formatting with box drawing for annotated diagrams:

```markdown
### ┌─ **System Architecture** ─┐

│
├──► **Input Layer** ── `validates data`
│ │
│ ▼
├──► **Processor** ── _transforms_
│ │
│ ▼
└──► **Output** ── [docs](https://example.com)
```

### Dashboard Mockups

Use tables with Unicode for visual dashboards:

```markdown
| Metric | Status  | Trend |
| ------ | ------- | ----- |
| CPU    | `42%`   | ▲     |
| Memory | `78%`   | ▼     |
| Disk   | **92%** | ━     |
```

### Progress Indicators

```markdown
Loading: █████████░░░░░░░░░░░ 45%
```

### Flowcharts

```markdown
┌─────────┐ ┌─────────┐ ┌─────────┐
│ Start │────►│ Process │────►│ End │
└─────────┘ └────┬────┘ └─────────┘
│
▼
┌─────────┐
│ Error │
└─────────┘
```

## Summary Table

| Category            | Feature                                             | Status       |
| ------------------- | --------------------------------------------------- | ------------ |
| **Text Formatting** | bold, italic, code                                  | ✓            |
| **Text Formatting** | strikethrough                                       | ✗            |
| **Structure**       | headers, tables, lists, blockquotes, hr             | ✓            |
| **Links**           | clickable URLs                                      | ✓            |
| **Code**            | syntax highlighting (JS, TS, HTML, CSS, Bash, JSON) | ✓            |
| **Code**            | syntax highlighting (Liquid)                        | ✗            |
| **Unicode**         | box drawing, blocks, braille                        | ✓            |
| **Injection**       | ANSI codes                                          | ✗ (escaped)  |
| **Injection**       | Ink/React components                                | ✗ (stripped) |
| **Injection**       | HTML entities                                       | ✗ (literal)  |

## Methodology

This documentation was created through systematic experimentation in a Claude Code session, testing various formatting options and observing actual terminal output. Each feature was verified by:

1. Outputting test content
2. User reporting what actually rendered
3. Iterating on edge cases

---

_Last updated: January 2026_
_Tested with: Claude Code (Ink-based TUI)_
