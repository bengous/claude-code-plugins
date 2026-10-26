/**
 * What holds each rule of the root `AGENTS.md` and of `.claude/rules/`, read by
 * `scripts/check-rule-registry.ts` (the `rule-registry` gate). A rule is a text
 * block, headings and code aside: a paragraph, a top-level list item, a table
 * row. The key is a fingerprint of its text, so an edited rule loses its entry
 * and the gate names the new key. `held` names the controls that enforce what
 * the rule says is checked, each `<gate|hook|lint|test> <name>`; `prose` says
 * why no tool can. A paragraph's `covers: "list"` holds the list that follows
 * it; without it, each item has its own entry.
 */

import type { Registry } from "../scripts/check-rule-registry.ts";

export const REGISTRY: Registry = {
  "AGENTS.md": {
    "8fc74a36": { quote: "One directory per plugin, listed in", prose: "a fact about the layout" },
    "26699aed": {
      quote: "Do not reinvent plugin patterns. Delegate:",
      prose: "which tool fits a task is a judgement",
      covers: "list",
    },
    af9d742f: {
      quote: "New plugin: add its `marketplace.json` entry and its",
      held: ["hook scripts/sync-versions.ts", "gate validate-marketplace"],
    },
    e720734e: {
      quote: "Agents never bump a version or write a `CHANGELOG.md`",
      held: ["hook scripts/check-plugin-bumps.ts", "test scripts/release.integration.test.ts"],
    },
    f8c3afb9: {
      quote: "For plugin tests, permissions and the catalog lifecycle,",
      prose: "a pointer to the pages that hold the detail",
    },
    "195c7036": {
      quote: "`vellum/`, `pinpoint/` and `atlas/` carry `package.json` +",
      prose: "a bare `bun test` installs nothing; `run-gates.ts` and CI install first",
    },
    "4d9290b5": {
      quote: "`pre-commit` and `pre-push` run the gates; CI runs them all",
      held: ["gate lint-config", "hook scripts/run-gates.ts", "hook scripts/affected.ts"],
    },
    "9679b29c": { quote: "| Layer | Language | Boundary |", prose: "the table's header" },
    cdfaa70d: {
      quote: "| Logic | TypeScript on Bun | Parsing, branching, state.",
      prose: "no check pairs a script's logic with its tests",
    },
    "53dc6d7e": {
      quote: "| Glue | bash | Wiring only. Stop at ~150 lines, or at the",
      prose: "no check counts a script's lines or reads what its `jq` builds",
    },
    e0256d65: {
      quote: "Extensions are mandatory: `.ts`, `.tsx`, `.sh`. The gates",
      prose: "no check refuses a script with no extension; the gates skip it",
    },
    cf4262d2: {
      quote: "Plugins are self-contained. No import crosses a plugin",
      prose: "no lint rule or test reads where an import points",
    },
    c7b55ea9: {
      quote: "Ship sources, never compiled binaries. `bun` is the runtime.",
      prose: "no check reads what a plugin ships",
    },
    "4fd7f1a6": {
      quote: "A change of behaviour or of a data model, once a first",
      prose: "what changes a behaviour is a judgement",
    },
    d0ee4058: {
      quote: "One writer per worktree.",
      prose: "no hook knows which agent owns a worktree",
    },
    "660d31af": {
      quote: "In an agent worktree, a Bash call runs one simple command:",
      prose:
        "the guard that refuses is Claude Code's own; this repo's Bash hooks guard pushes, releases and settings writes, not a command's shape",
    },
    "70ce207e": {
      quote: "A step that code can decide is done by the script or the",
      prose:
        "what code can decide is the judgement this rule asks for; the rule registry records it",
    },
    dbf56d05: {
      quote: "`archive/` - retired plugins, not in the marketplace.",
      prose: "a fact about the directory, no rule to hold",
    },
    "6573bd70": {
      quote: "`tools/oxlint/anti-slop/` - vendored lint plugin. Do not",
      held: ["gate lint-config"],
    },
    "32b88bf5": {
      quote: "`tools/oxlint/local/` - the repo's own lint plugin, edited",
      held: ["gate lint-config"],
    },
    e4faa8be: {
      quote: "`dev` is the working trunk; `main` is the release channel",
      prose:
        "lefthook's `block-commit-to-main` and the agent-hooks landing guard refuse an agent's commit and push to `main`, but the fast-forward, the linear history and the signed commits are the GitHub rulesets', which no check of this repo reads",
    },
    efdba6e9: {
      quote: "Claude Code's built-in \"Commit or push only when the user",
      held: ["hook agent-hooks/agent-hooks.ts", "test agent-hooks/pre-bash.integration.test.ts"],
    },
    b5f9452a: {
      quote: "Two lanes; the agent judges by scope, the user can override:",
      prose: "a lead-in; each lane below has its own entry",
    },
    "8706f9f1": {
      quote: "Inline — one concern, small diff: commit directly on `dev`.",
      held: ["hook scripts/check-e2e-green.ts"],
    },
    c316b6bb: {
      quote: "Branch — several concerns, big work (large feature, large",
      prose: "the lane, the split into PRs and when to rebase are judgements of scope",
    },
    "045c3965": {
      quote: "Review: one agent review, once, on a branch that touches the",
      prose: "a review is a judgement; no tool reads a finding",
    },
    b3476aba: {
      quote: "Before any push or release: follow [Repo",
      prose:
        "a procedure to follow; the agent-hooks landing guard refuses its pushes to `main` agent-side",
    },
  },
  ".claude/rules/function-hooks.md": {
    "475429f7": {
      quote: "The generated types say what `$` and `on` accept;",
      prose: "a pointer to the cheat sheet",
    },
  },
  ".claude/rules/hook-ladder.md": {
    "343a0dde": {
      quote: "The rungs run from each edit to CI: post-edit, Stop,",
      prose: "a summary of the rungs the items below describe",
    },
    e9909db4: {
      quote: "The post-edit hook (`format-on-edit.ts`) fixes, formats and",
      held: [
        "hook .claude/hooks/format-on-edit.ts",
        "test .claude/hooks/format-on-edit.integration.test.ts",
      ],
    },
    a361cf40: {
      quote: "`--fix` applies the fixes oxlint rates safe, never",
      prose: "oxlint rates its own fixes, and no repo check reads the rating",
    },
    b0298a8f: {
      quote: "The tools run from the checkout of the project's repository",
      held: ["test .claude/hooks/format-on-edit.integration.test.ts"],
    },
    a34837a7: {
      quote: "Per-edit cost, measured on 2026-09-14 with hyperfine on",
      prose: "a measurement, kept with its conditions",
    },
    "29cf4b80": {
      quote: "The Stop and each subagent's SubagentStop are the",
      held: ["hook scripts/run-gates.ts", "test agent-hooks/stop.integration.test.ts"],
    },
    "33ff07c7": {
      quote: "A new gate is one `EXPECTED_COMMANDS` entry in",
      held: ["gate lint-config"],
    },
    "61ef1d46": {
      quote: "Tests stay out of Stop: every suite takes about 36 s here in",
      prose: "a trade-off of cost",
    },
    "7ed69bd9": {
      quote: "Known ceilings:",
      prose: "limits of the ladder, not rules",
      covers: "list",
    },
  },
  ".claude/rules/skill-commands.md": {
    "661710b6": {
      quote: "The model copies a skill's example commands verbatim, so",
      prose: "why the items below hold, with a pointer to the measured cases",
    },
    "6871d369": {
      quote: "No environment assignment in front of the executable: an",
      prose: "no check reads a skill's example commands",
    },
    "7e66185e": {
      quote: "No `$(...)` or backtick substitution: it prompts in",
      prose: "no check reads a skill's example commands",
    },
    "2fa0b5a8": {
      quote: "No editor: the session exports `GIT_EDITOR=true`, which",
      prose: "no check reads a skill's example commands",
    },
    "1f590ba9": {
      quote: "`allowed-tools` file rules are `Read(path)` and `Edit(path)`",
      prose: "`validate-frontmatter` checks the keys, not the rules `allowed-tools` holds",
    },
    "36592a19": {
      quote: "A `Bash` rule does not cover a path argument outside the",
      prose: "only the permission check knows the working directory of a session",
    },
    "69d6451b": {
      quote: "A skill that writes scratch files gives each run its own",
      prose: "no check reads where a skill writes",
    },
    "6133375a": {
      quote: '`description` ends with a "Use when ..." clause naming the',
      prose: "`validate-frontmatter` does not read a description's wording",
    },
    f46e61f7: {
      quote: "A skill whose effect leaves the machine or rewrites history",
      prose: "whether an effect can be undone is a judgement",
    },
  },
  ".claude/rules/test-tiers.md": {
    "65a8aa47": {
      quote: "A test file that starts a process (`git`, `bun`, a CLI, a",
      prose: "whether a test starts a process is known only by running it",
    },
  },
};
