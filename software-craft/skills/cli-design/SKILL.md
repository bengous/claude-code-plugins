| name | description | license |
|------|-------------|---------|
| cli-design | Create distinctive, user-respecting command-line interfaces with exceptional UX. Use this skill when the user asks to build CLI tools, scripts, or terminal applications. Generates well-crafted CLIs that follow platform conventions and treat users as humans, not machines. | MIT |

This skill guides creation of command-line interfaces that respect users' time and intelligence. Implement real working CLIs with exceptional attention to ergonomics, error handling, and composability.

The user provides CLI requirements: a tool, script, or terminal application to build. They may include context about the purpose, target users, or technical constraints.

<cli_design_thinking>
## Design Thinking

Before coding, understand the context and commit to a clear interaction model:

- **Purpose**: What task does this tool accomplish? How often will users run it?
- **Users**: Power users who'll alias it? Occasional users who'll forget flags? Scripts and automation?
- **Scope**: Single-purpose tool or multi-command suite? Pipes and composition or standalone?
- **Personality**: Minimal and silent? Friendly and helpful? Technical and precise?

CLIs are conversations. Every invocation is a turn in a dialogue. Design for the user who runs your command wrong the first time—that's the normal case.

Then implement working code that is:

- Production-grade and robust to unexpected input
- Respectful of platform conventions (POSIX, GNU, XDG)
- Helpful when things go wrong
- Composable with pipes, scripts, and other tools
</cli_design_thinking>

<cli_ux_guidelines>
## CLI UX Guidelines

### Progressive Disclosure
Simple by default, power available. The 90% use case should require zero flags. Advanced options exist but don't clutter basic usage.

<example_good title="Progressive help">
# Basic usage shows essentials
$ mytool --help
Usage: mytool <file>

Process files efficiently.

Options:
  -o, --output <path>  Output location (default: stdout)
  -h, --help           Show this help

Run 'mytool --help-all' for advanced options.
</example_good>

### Error Messages
Errors are teaching moments. Tell users what went wrong, why, and how to fix it.

<example_bad title="Hostile error">
$ mytool config.yaml
Error: invalid input
</example_bad>

<example_good title="Helpful error">
$ mytool config.yaml
Error: Cannot read 'config.yaml': file not found

Did you mean one of these?
  ./configs/config.yaml
  ./config.yml

Run 'mytool --help' for usage.
</example_good>

### Output Design
Human-readable by default. Machine-readable on request.

<example_good title="Output modes">
# Human (default)
$ mytool status
✓ Database: connected (15ms)
✓ Cache: healthy (3ms)
✗ API: timeout after 5000ms

# Machine (--json)
$ mytool status --json
{"database":{"ok":true,"latency_ms":15},"cache":{"ok":true,"latency_ms":3},"api":{"ok":false,"error":"timeout"}}
</example_good>

Respect TTY detection—no colors in pipes. Confirm state changes ("Created config.json"). Show progress for anything over 1 second.

### Flag Conventions
- Long flags for clarity (`--output`), short flags for frequency (`-o`)
- Standard names: `--help`, `--version`, `--verbose`, `--quiet`, `--dry-run`, `--force`, `--json`
- Boolean flags don't take values
- Order-independent flags

<example_good title="Standard flags">
$ mytool --version
mytool 2.1.0

$ mytool -v process data.csv      # -v = --verbose
$ mytool process data.csv -v      # same result, order doesn't matter
$ mytool --dry-run delete old/    # shows what would be deleted
</example_good>

### Argument Design
- Prefer flags over positional args for non-obvious inputs
- Support `-` for stdin/stdout
- Validate early, fail fast with clear messages
- Provide flag alternatives for every prompt

<example_good title="Stdin support">
$ cat data.csv | mytool process -
$ mytool process - < data.csv
$ mytool process data.csv -o -  # output to stdout
</example_good>

### Configuration Hierarchy
Apply configuration in this order: Flags → Environment → Project config → User config → Defaults.

<example_good title="Config precedence">
$ mytool --output /tmp/out.txt    # 1. Flag wins
$ MYTOOL_OUTPUT=/var/out.txt mytool  # 2. Env var
# .mytoolrc in project: output: ./out.txt  # 3. Project
# ~/.config/mytool/config: output: ~/out.txt  # 4. User
# Built-in default: stdout  # 5. Default
</example_good>
</cli_ux_guidelines>

<cli_anti_patterns>
## Patterns to Avoid

Avoid hostile errors that leave users stranded:
- "Error: invalid input" → Instead: name the invalid input and suggest corrections
- Exit code 1 for everything → Instead: use distinct codes (1=user error, 2=system error, etc.)
- Stack traces as errors → Instead: catch exceptions and print human messages

Avoid breaking conventions that users expect:
- `-help` instead of `--help` → Use GNU-style double-dash for long flags
- Requiring flag order → Let `cmd -v file` and `cmd file -v` work the same
- Secrets in flags → Read from stdin, files, or env vars instead

Avoid user-hostile defaults:
- Destructive operations without confirmation → Add `--force` to skip confirmation
- Silent failures → Always indicate success or failure
- Mandatory prompts → Provide `--yes` or flag alternatives

Avoid output crimes:
- Colors in non-TTY → Check `isatty()` and respect `NO_COLOR`
- Progress bars that break pipes → Detect when output isn't a terminal
- Mixing data and messages on stdout → Data to stdout, messages to stderr
</cli_anti_patterns>

<cli_success_criteria>
## Success Criteria

Your CLI is well-designed when:

1. **First-time users succeed**: Running `cmd --help` gives them enough to complete basic tasks
2. **Errors guide recovery**: Every error message answers "what happened?" and "what should I try?"
3. **Scripts work reliably**: Exit codes are meaningful, output is parseable with `--json`, no interactive prompts block automation
4. **Power users stay efficient**: Short flags exist for common options, shell completion works, config files reduce typing
5. **It composes well**: Reads from stdin, writes to stdout, plays nicely in pipelines
</cli_success_criteria>

<cli_complexity_matching>
## Match Complexity to Scope

A single-purpose tool needs minimal flags and maximum clarity—think `cat`, `wc`, `head`.

A multi-command suite needs consistent subcommand structure, shared flags, and shell completions—think `git`, `docker`, `kubectl`.

Don't add a plugin system to a grep replacement. Don't force a simple tool into a subcommand hierarchy it doesn't need.
</cli_complexity_matching>

The best CLIs feel like they were written by someone who uses the terminal 8 hours a day and has strong opinions about what makes tools pleasant to use. Channel that energy.
