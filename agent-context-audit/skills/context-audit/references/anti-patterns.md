# Anti-Pattern Detection Catalog

Reference catalog for Phase 4 (Anti-Pattern Detection). Organized by detection type with keyword patterns, examples, and proposal templates.

---

## 1. Linter Overlap

**Severity:** HIGH — These directives are enforced by tools and waste budget every session.

### Config files that signal linter presence

| File | Tool | Domain |
|------|------|--------|
| `biome.json`, `biome.jsonc` | Biome | formatting, linting, import sorting |
| `.eslintrc*`, `eslint.config.*` | ESLint | linting |
| `.prettierrc*`, `prettier.config.*` | Prettier | formatting |
| `.editorconfig` | EditorConfig | indentation, line endings |
| `deno.json`, `deno.jsonc` | Deno | formatting, linting |
| `ruff.toml`, `pyproject.toml [tool.ruff]` | Ruff | Python linting, formatting |
| `pyproject.toml [tool.black]` | Black | Python formatting |
| `.stylelintrc*` | Stylelint | CSS linting |
| `.rubocop.yml` | RuboCop | Ruby linting |
| `rustfmt.toml`, `.rustfmt.toml` | rustfmt | Rust formatting |
| `.clang-format` | clang-format | C/C++ formatting |

### Overlap keywords

When a linter config exists, flag context file directives matching these patterns:

**Indentation/whitespace:** indent, tab, space, 2-space, 4-space, whitespace, trailing whitespace, line ending, newline, EOL

**Formatting:** semicolon, trailing comma, single quote, double quote, quote style, line length, max line, print width, bracket spacing, brace style, parentheses

**Import/module:** import order, sort import, import style, import grouping, barrel import, re-export

**Naming:** camelCase, PascalCase, snake_case, SCREAMING_SNAKE, naming convention, variable naming

### Proposal template

```
REMOVE: Lines X-Y
Content: "[the style directive]"
Reason: Already enforced by [tool] via [config file]. Linter rules are deterministic
  and run automatically — duplicating them in the context file wastes instruction budget
  without improving behavior.
Budget impact: Recovers ~1 directive slot
Confidence: HIGH (linter config verified to exist)
```

---

## 2. Generic Advice

**Severity:** MEDIUM — Wastes budget but does not actively mislead.

### Detection approach

Cross-reference directives against `references/default-behaviors.md`. Additionally, apply the **specificity test**: a directive with zero project-specific tokens (no file paths, tool names, library names, custom terms, concrete commands) is likely generic.

### Common generic phrases

- write clean code
- follow best practices
- use meaningful names / descriptive names
- keep code readable / maintainable
- be consistent
- follow conventions
- use proper error handling
- write good tests / comprehensive tests
- keep functions small / focused
- don't repeat yourself / DRY
- separate concerns
- single responsibility
- document your code
- comment complex logic (unless paired with specific file/pattern)

### Proposal template

```
REMOVE: Line X
Content: "[generic directive]"
Reason: Fails the deletion test — removing this would not cause Claude to make mistakes.
  [Choose one:]
  - Claude already does this by default (see default-behaviors.md)
  - This contains no project-specific information
  - This restates a behavior covered by the system prompt
Budget impact: Recovers ~1 directive slot
Confidence: MEDIUM (heuristic judgment — verify directive has no hidden project-specific value)
```

---

## 3. Verbose Content

**Severity:** MEDIUM-HIGH — Directly inflates token cost of always-on context.

### Detection signals

- **Long directives:** Single bullet/directive exceeding ~30 words where a shorter version conveys the same meaning
- **Embedded code blocks:** Code blocks >10 lines inline (should reference file path instead)
- **Large @file imports:** Imported files >50 lines (should be "see X for details" and let agent read on demand)
- **Low directive density:** File where directives / total lines < 0.3 (more than 70% overhead)
- **Explanation-heavy sections:** More prose than directives in a section

### Proposal templates

**Verbose directive:**
```
REWRITE: Line X
Before: "[verbose version — N words]"
After: "[concise version — M words]"
Reason: Same directive, N% fewer tokens. The concise version preserves all actionable information.
Budget impact: Token savings (~N-M words), clarity improvement
Confidence: MEDIUM (rewrite preserves meaning — verify)
```

**Embedded code block:**
```
REWRITE: Lines X-Y
Before: [10+ line code block embedded inline]
After: "See `path/to/file` for [description]"
Reason: Embedded content consumes budget every session. Reference the file path instead
  and let the agent read on demand when relevant.
Budget impact: Significant token savings (~N lines removed from always-on context)
Confidence: MEDIUM (verify the referenced file exists and is discoverable)
```

**Large @file import:**
```
REWRITE: Line X
Before: "@path/to/large-file.md"
After: "For [topic], see `path/to/large-file.md`"
Reason: @file imports embed the entire file into every session context. At N lines,
  this import consumes significant budget. Converting to a reference lets the agent
  read it only when relevant.
Budget impact: Recovers ~N directive slots from always-on surface
Confidence: HIGH (file size is deterministic)
```

---

## 4. Non-Universal Instructions

**Severity:** MEDIUM — Each wastes budget in sessions where it's irrelevant.

### Detection signals

**Path-specific directives:** References to specific subdirectories or file patterns:
- "When working on the API..."
- "In `src/frontend/`..."
- "For database migrations..."
- "In React components..."

**Conditional language:**
- "when working on", "for X projects", "if using", "only for", "in the case of"
- "only applies to", "specific to", "when you encounter"

**Framework/library-specific in partial codebases:** Directives mentioning libraries that only apply to part of the codebase (e.g., "Use Zod for validation" in a monorepo where only the API uses Zod).

### Scope assessment

Estimate what fraction of the codebase a directive covers:
- Count files/directories referenced by the directive
- Compare to total codebase size
- If <20% coverage, it's a strong candidate for path-scoped rule

### Proposal template

```
MOVE: Lines X-Y → .claude/rules/[suggested-name].md
Content: "[section or directive]"
Reason: These directives reference [specific area] which represents ~N% of the codebase.
  Moving to a path-scoped rule means they load only when Claude works on those files,
  freeing budget in the ~(100-N)% of sessions where they're irrelevant.
Suggested file:
  ---
  paths: [glob pattern, e.g., src/api/**]
  ---
  [moved content]
Budget impact: Recovers ~N directive slots from always-on surface
Confidence: MEDIUM (scope estimate is heuristic — verify paths are correct)
```

---

## 5. Negative Instructions Without Alternatives

**Severity:** MEDIUM — Leaves the agent stuck with no path forward.

### Detection pattern

Look for directives containing negative keywords:
- never, don't, do not, avoid, must not, should not, shouldn't, can't, cannot, won't

Then check if the same directive (or the immediately following one) contains a positive alternative:
- instead, prefer, use, rather, replace with, switch to, try, consider, opt for

If no alternative is present, it's a dead-end negative.

### Examples

**Dead-end (flag):** "Never use the `any` type"
**With alternative (ok):** "Avoid `any`; prefer `unknown` with type narrowing"

**Dead-end (flag):** "Don't use default exports"
**With alternative (ok):** "Use named exports instead of default exports"

**Dead-end (flag):** "Never use `--force` with git push"
**With alternative (ok):** "Use `--force-with-lease` instead of `--force` when force-pushing"

### Proposal template

```
REWRITE: Line X
Before: "[negative directive without alternative]"
After: "[positive framing with alternative]"
Reason: Negative-only directives leave the agent with no path forward. Adding the
  preferred alternative makes the instruction actionable and increases adherence.
Budget impact: Same directive count, improved adherence
Confidence: MEDIUM (verify the suggested alternative is correct for this project)
```

---

## Claude Code Native References (Do NOT Flag)

These patterns are valid Claude Code ecosystem references and must not be flagged as stale or broken:

| Pattern | What it is |
|---------|-----------|
| `/command-name` | Slash command invocation |
| `Skill(skill: "name")` | Skill invocation |
| `${CLAUDE_PLUGIN_ROOT}/...` | Plugin-relative path (resolved at runtime) |
| `Task(...)` / `Agent(...)` | Subagent tool calls |
| `.claude/rules/`, `.claude/settings.json` | Claude Code config paths |
| `~/.claude/CLAUDE.md` | Global config path |
| `CLAUDE.local.md` | Local override file |
| `@path/to/file` | File import syntax |
| `#` (key shortcut reference) | Session memory capture |
