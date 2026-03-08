# The art of writing AI agent configuration files

**The single most important insight from the research: your CLAUDE.md or AGENTS.md file is not a manual — it's a constitution.** Frontier LLMs can reliably follow roughly **150–200 instructions**, and Claude Code's system prompt already consumes about 50 of those. Every line you add competes for attention in a finite instruction budget, and research confirms that as instruction count increases, adherence to *all* instructions degrades uniformly. The best agent configuration files in production today are **under 100 lines**, treat the file as the highest-leverage prompt engineering artifact in the entire workflow, and use progressive disclosure to push detail into separate documents the agent reads on demand.

This synthesis draws from Anthropic's official documentation, the HumanLayer deep analysis (748 points on Hacker News), GitHub's study of 2,500+ repositories, community discussions across Reddit and Hacker News, and dozens of blog posts and open-source examples from 2024–2025.

---

## The research that proves less is more

The HumanLayer analysis, published November 2025, became the canonical reference for this topic by surfacing a critical technical detail: Claude Code wraps CLAUDE.md contents with a system reminder stating *"this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task."* This means **Claude actively deprioritizes instructions it considers irrelevant** to the current task. The more irrelevant content in your file, the more aggressively the model ignores everything — including the relevant parts.

Academic research (arxiv.org/pdf/2507.11538) confirmed the mechanism. Frontier thinking models exhibit **linear decay** in instruction-following as instruction count increases, while smaller models show exponential decay. The practical ceiling is approximately 150–200 total instructions with reasonable consistency. Since Claude Code's system prompt already claims roughly a third of that budget, your CLAUDE.md realistically gets **100–150 instruction slots** before degradation becomes noticeable.

Anthropic's own documentation states that **files over 200 lines consume more context and may reduce adherence**, and recommends keeping files concise and human-readable. HumanLayer's production CLAUDE.md is under **60 lines**. The community consensus converges on a sweet spot of **60–120 lines** for the root configuration file. One widely-cited test for instruction adherence: a developer added "always address me as Mr. Tinkleberry" to their CLAUDE.md — when Claude stopped using the name, they knew their file had grown too bloated.

---

## What belongs in the file and what doesn't

The most effective files follow a **WHAT/WHY/HOW framework**: tell the agent what the project is, why it exists, and how to work on it. GitHub's analysis of 2,500+ repositories found that the best-performing specs consistently cover **six areas**: commands, testing, project structure, code style, git workflow, and boundaries.

Anthropic's official recommendation for content categories includes common bash commands, core files and utility functions, code style guidelines (brief), testing instructions, repository etiquette, developer environment setup, and unexpected behaviors or warnings. Their own example is strikingly terse:

```markdown
# Bash commands
- npm run build: Build the project
- npm run typecheck: Run the typechecker

# Code style
- Use ES modules (import/export) syntax, not CommonJS (require)
- Destructure imports when possible

# Workflow
- Be sure to typecheck when you're done making code changes
- Prefer running single tests, not the whole test suite
```

The builder.io and aihero.dev guides push minimalism even further, arguing the root-level file needs only a **one-sentence project description** and the **package manager** if it's not npm. Everything else belongs in progressive disclosure files. The rationale: agents are fast at navigating documentation hierarchies and understand context well enough to find what they need.

### The anti-patterns that destroy performance

The research reveals a clear set of things that actively harm agent performance:

- **Using the agent as a linter.** HumanLayer's strongest position: "Never send an LLM to do a linter's job." Code style guidelines add mostly-irrelevant instructions and code snippets to the context window, degrading performance on the tasks that actually matter. Use Biome, ESLint, or Prettier via hooks instead. Claude Code supports pre- and post-edit hooks that run formatters automatically.

- **Auto-generating without refinement.** The `/init` command is useful as a starting point, but CLAUDE.md is the highest-leverage prompt in your entire workflow. A bad line affects every phase of every task. Anthropic recommends `/init` followed by aggressive curation; HumanLayer argues you should hand-craft every line.

- **Stuffing everything into one file.** Instruction overload causes uniform degradation. Task-specific guidance (how to structure a database schema, how to write a migration) distracts the model during unrelated tasks. One Hacker News commenter noted: "I'm surprised people don't use multiple CLAUDE.md files in subdirectories — Claude loads them on demand when it reads files in that directory."

- **Negative instructions without alternatives.** Writing "never use --foo-bar flag" leaves the agent stuck with no path forward. Always provide the alternative: "Never use --foo-bar; prefer --baz instead."

- **Including non-universal instructions.** If a rule only applies to 20% of sessions, it's consuming budget in the other 80%. Move it to a subdirectory CLAUDE.md or a `.claude/rules/` file scoped with path frontmatter.

- **Embedding full file contents.** Using `@file` imports embeds entire documents into every session. Instead, use descriptions like "For complex usage or FooBarError, see path/to/docs.md" and let the agent read them only when needed.

Anthropic offers a clean diagnostic heuristic: **"For each line, ask: would removing this cause Claude to make mistakes? If not, cut it."** If Claude keeps doing something wrong despite a rule against it, the file is probably too long. If Claude asks questions answered in the file, the phrasing is probably ambiguous.

---

## Progressive disclosure is the key architectural pattern

The most sophisticated practitioners converge on the same structure: a lean root file that acts as an index, pointing to detailed documents the agent reads on demand.

```
agent_docs/
  ├── building_the_project.md
  ├── running_tests.md
  ├── code_conventions.md
  ├── service_architecture.md
  └── database_schema.md
```

The root CLAUDE.md or AGENTS.md lists these files with one-line descriptions, instructing the agent to decide which are relevant before starting work. Claude Code supports this natively — **subdirectory CLAUDE.md files load on demand** when Claude reads files in those directories, not at launch. This keeps active context focused.

For path-scoped rules, Claude Code's `.claude/rules/` directory supports YAML frontmatter targeting:

```yaml
---
paths: src/api/**/*.ts
---
# API Development Rules
- All endpoints must validate input with Zod
- Return consistent error shapes
```

Cursor's `.mdc` format offers equivalent scoping via `globs:` frontmatter, and GitHub Copilot supports `.instructions.md` files with `applyTo` metadata. The principle is universal: **scope instructions to the contexts where they matter**.

---

## Writing a unified file across Claude, Cursor, Copilot, and Windsurf

The proliferation of tool-specific configuration files — CLAUDE.md, .cursorrules, copilot-instructions.md, .windsurfrules — created a real pain point. **AGENTS.md has emerged as the de facto universal standard**, now governed by the Agentic AI Foundation under the Linux Foundation with co-founders including OpenAI, Anthropic, and Block. Over **60,000 GitHub repositories** have adopted it, and it's supported by 20+ tools including Codex, Cursor, GitHub Copilot, Gemini CLI, Windsurf, Aider, Amp, Devin, and VS Code.

The recommended architecture: put **80% of shared rules** in AGENTS.md, keep tool-specific features in dedicated files.

```
project-root/
├── AGENTS.md                    ← Shared rules (build, testing, conventions)
├── CLAUDE.md                    ← "See @AGENTS.md" + Claude-specific settings
├── .github/
│   └── copilot-instructions.md  ← Symlink → ../AGENTS.md or Copilot-specific
├── .cursor/
│   └── rules/
│       └── main.mdc             ← Symlink → ../../AGENTS.md or Cursor-specific
└── .windsurf/
    └── rules/
        └── general.md           ← Symlink → ../../AGENTS.md or Windsurf-specific
```

A minimal CLAUDE.md can be as simple as `See @AGENTS.md` with any Claude-specific MCP settings or thinking instructions appended. For Cursor's `.mdc` format, you may need YAML frontmatter (`alwaysApply: true`) that AGENTS.md doesn't use — symlinks work but you lose frontmatter features.

### Symlink strategies and automation tools

Three approaches exist for maintaining a single source of truth:

**Symlinks** are the most popular cross-tool approach. The basic setup:
```bash
ln -s AGENTS.md CLAUDE.md
ln -s ../AGENTS.md .github/copilot-instructions.md
mkdir -p .cursor/rules && ln -sfn ../../AGENTS.md .cursor/rules/main.mdc
```

For global user-level preferences, a central `~/.agents/AGENTS.md` can be symlinked into `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, and other tool-specific directories. Caveats: some CI environments and Windows don't handle symlinks well, and Cursor has had intermittent bugs with symlinked `.mdc` files.

**Pointer files** offer a simpler alternative: each tool-specific file contains only a reference like `See @AGENTS.md` (Claude) or `READ AGENTS.md FIRST` (other tools).

**Automation tools** have emerged to solve this at scale. **Ruler** (by intellectronica) maintains a centralized `.ruler/` directory and generates all agent configs with `ruler apply`. **rulesync** uses YAML frontmatter to generate target-specific outputs. **ai-rules** from Block generates rules for 11+ agents from a single source. **agentlink** manages symlinks via `.agentlink.yaml` config. One team reported reducing from 310 lines across 3 tools with ~80% duplication to 120 total lines with zero duplication after adopting the shared-source pattern.

---

## TypeScript and Node.js monorepo patterns

For TypeScript monorepos, the hierarchical file pattern becomes essential. The root AGENTS.md/CLAUDE.md covers universal conventions, while per-package files handle package-specific commands, dependencies, and patterns.

```
monorepo/
├── AGENTS.md              # Universal: package manager, build system, CI
├── packages/
│   ├── core/
│   │   └── AGENTS.md      # Core package: shared types, utilities
│   ├── ui/
│   │   └── AGENTS.md      # React patterns, component conventions
│   └── api/
│       └── AGENTS.md      # API conventions, validation rules
└── apps/
    └── web/
        └── AGENTS.md       # App deployment, env vars, routing
```

The most commonly recommended TypeScript-specific rules across 130+ analyzed cursor rules and community examples include: **use TypeScript strict mode**, prefer interfaces over types, avoid enums in favor of const objects or maps, use functional and declarative patterns over classes, use ES modules (import/export) not CommonJS, destructure imports, use `import type` for type-only imports, prefer async/await over callbacks, and use descriptive variable names with auxiliary verbs (isLoading, hasError).

For package manager conventions, the rules file must specify the exact tool. The difference between `pnpm turbo run test --filter <package>`, `yarn workspace <pkg> test`, and `npm run test --workspace=<pkg>` is precisely the kind of detail that prevents agent confusion. Include the **exact commands with flags** the agent should run. GitHub's study found that executable commands with full flags were the single most impactful content category.

A practical TypeScript monorepo root file:

```markdown
# Project: [Name]
TypeScript monorepo using pnpm + Turborepo.

## Commands  
- `pnpm install` — Install all dependencies
- `pnpm turbo run build` — Build all packages  
- `pnpm turbo run test --filter <package>` — Test specific package
- `pnpm run check-types` — TypeScript type checking across workspace

## Conventions
- Named exports only (no default exports)
- TypeScript strict mode, no `any` types
- `import type { ... }` for type-only imports
- Functional components (React packages)

## Structure
- `packages/` — Shared libraries
- `apps/` — Deployable applications
- Each package has its own tsconfig.json extending root

## Safety
- Never commit .env files
- Ask before installing new dependencies
- Run type checking after code changes
```

---

## How Anthropic's own teams approach these files

Anthropic's engineering blog and internal case studies reveal several practices worth noting. Their teams **check CLAUDE.md into git** and contribute to it multiple times per week. Boris Cherny, creator of Claude Code, describes the workflow: "Anytime we see Claude do something incorrectly we add it to the CLAUDE.md, so Claude knows not to do it next time." During code review, engineers tag `@.claude` on pull requests to suggest CLAUDE.md additions.

Anthropic occasionally runs CLAUDE.md files through their **prompt improver** tool and tunes instructions with emphasis markers — "IMPORTANT" and "YOU MUST" — for critical rules. They use the **# key** during coding sessions to capture instructions Claude should remember, which get auto-incorporated into the relevant CLAUDE.md. Their end-of-session practice asks Claude to summarize work and suggest CLAUDE.md improvements, creating a continuous improvement loop.

The hierarchy of CLAUDE.md files in Claude Code is worth understanding precisely. Enterprise policy files (system-wide, cannot be excluded) load first. User-level `~/.claude/CLAUDE.md` applies to all sessions. Project-level `./CLAUDE.md` and `./.claude/CLAUDE.md` are equivalent. Parent directory files load in full at launch — critical for monorepos. Child directory files **load on demand** when Claude accesses files in those directories. Personal `CLAUDE.local.md` files are auto-gitignored for private preferences.

---

## Real-world examples that demonstrate the principles

The **browser-use monorepo CLAUDE.md** (by @pirate) is frequently cited as one of the best public examples: approximately 120 lines, terse sections covering repository overview, development commands, architecture guidelines, testing strategy, key development patterns, and monorepo working instructions. It explicitly marks "less important components" to ignore unless directed, specifies indentation differences between sub-projects, and states an opinionated testing strategy: "Write failing tests first. Use real objects instead of mocks for everything aside from the LLM."

OpenAI's Codex repository demonstrates the hierarchical approach at scale with **88 AGENTS.md files** across its monorepo. Each file contains package-specific build and test instructions, sandbox-aware guidance ("You operate in a sandbox where CODEX_SANDBOX_NETWORK_DISABLED=1 will be set"), and safety boundaries ("Never add or modify any code related to CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR").

The **cursor.directory** community site and **PatrickJS/awesome-cursorrules** repository (500+ rules) show a different pattern: cursor rules tend to be more verbose and persona-driven ("You are an expert in TypeScript, Node.js, Next.js App Router, React, Shadcn UI, Radix UI, and Tailwind") with heavy focus on code style patterns. This verbosity is precisely what the research suggests avoiding — it works for code completion hinting but consumes valuable context for agentic workflows.

---

## Conclusion

The evidence points to a clear set of principles. **Treat your agent configuration file as the most important prompt you write** — every line should pass the test of "would removing this cause the agent to make mistakes?" Use the root file as a lean constitution covering commands, stack, structure, and hard boundaries, then push everything else into progressive disclosure documents and path-scoped rules. Adopt AGENTS.md as the universal standard with symlinks or pointer files for tool-specific compatibility. For TypeScript monorepos, hierarchical per-package files eliminate the need for conditionals in a single bloated root document.

The most counterintuitive lesson from the research: **the agents are better at figuring things out from your codebase than you expect**. LLMs are powerful in-context learners. If your codebase follows consistent patterns, the agent will follow them without being told. The configuration file's job is not to teach the agent everything — it's to correct the specific things the agent gets wrong, provide the commands it can't discover, and establish the boundaries it must never cross. Document friction, not knowledge.