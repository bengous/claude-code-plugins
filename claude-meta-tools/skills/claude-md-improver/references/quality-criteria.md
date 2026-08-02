# CLAUDE.md Quality Criteria

## Scoring Rubric

Seven criteria totaling 100 points. For module/package-level CLAUDE.md files, Commands/Workflows is N/A — score the remaining criteria and rebase to 100 (`total / 80 × 100`).

### 1. Commands/Workflows (20 points)

*N/A for module/package-level files (see the Package template) — rebase as above.*

**20 points**: All essential commands documented with context
- Build, test, lint, deploy commands present
- Development workflow clear
- Common operations documented

**15 points**: Most commands present, some missing context

**10 points**: Basic commands only, no workflow

**5 points**: Few commands, many missing

**0 points**: No commands documented

### 2. Architecture Clarity (20 points)

**20 points**: Clear codebase map
- Key directories explained
- Module relationships documented
- Entry points identified
- Data flow described where relevant

**15 points**: Good structure overview, minor gaps

**10 points**: Basic directory listing only

**5 points**: Vague or incomplete

**0 points**: No architecture info

### 3. Non-Obvious Patterns (10 points)

**10 points**: Gotchas and quirks captured
- Known issues documented
- Workarounds explained
- Edge cases noted
- "Why we do it this way" for unusual patterns

**7 points**: Some patterns documented

**3 points**: Minimal pattern documentation

**0 points**: No patterns or gotchas

### 4. Conciseness (10 points)

**10 points**: Dense, valuable content
- No filler or obvious info
- Each line adds value
- No redundancy with code comments

**7 points**: Mostly concise, some padding

**3 points**: Verbose in places

**0 points**: Mostly filler or restates obvious code

### 5. Currency (15 points)

**15 points**: Reflects current codebase
- Commands work as documented
- File references accurate
- Tech stack current

**10 points**: Mostly current, minor staleness

**5 points**: Several outdated references

**0 points**: Severely outdated

### 6. Actionability (15 points)

**15 points**: Instructions are executable
- Commands can be copy-pasted
- Steps are concrete
- Paths are real

**10 points**: Mostly actionable

**5 points**: Some vague instructions

**0 points**: Vague or theoretical

### 7. Structure (10 points)

**10 points**: Well-organized memory surface
- File within the documented ~200-line target
- Thematic rule sets split into `.claude/rules/` (with `paths:` frontmatter where content is file-type-specific)
- No content duplicated across memory files

**7 points**: Minor sprawl, mostly organized

**3 points**: Over ~200 lines with no rules split

**0 points**: Monolithic file and/or duplication across memory files

## Assessment Process

1. Read the CLAUDE.md file completely
2. Cross-reference with actual codebase:
   - Verify documented commands exist (read-only check against package.json/Makefile — never execute them)
   - Check if referenced files exist
   - Verify architecture descriptions
3. Score each criterion
4. Calculate total and assign grade
5. List specific issues found
6. Propose concrete improvements

## Red Flags

- Commands that would fail (wrong paths, missing deps)
- References to deleted files/folders
- Outdated tech versions
- Copy-paste from templates without customization
- Generic advice not specific to the project
- "TODO" items never completed
- Duplicate info across multiple CLAUDE.md files
- Monolithic root CLAUDE.md (over ~200 lines) carrying thematic rule sets that belong in `.claude/rules/`
- Files named `.claude.local.md` (leading dot — never a loaded filename; the real one is `CLAUDE.local.md`)
