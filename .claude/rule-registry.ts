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
    "7e1dbe78": {
      quote: "New plugin: add its `marketplace.json` entry and its",
      held: ["hook scripts/sync-versions.ts", "gate validate-marketplace"],
    },
    f050d941: {
      quote: "For plugin tests, permissions and the catalog lifecycle,",
      prose: "a pointer to the pages that hold the detail",
    },
    b17ce01d: {
      quote: "`vellum/` and `pinpoint/` carry `package.json` + `bun.lock`:",
      prose: "a bare `bun test` installs nothing; `run-gates.ts` and CI install first",
    },
    "54183a81": {
      quote: "Everything above but the browser suite, the mutation run and",
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
    "1580a5e3": {
      quote: "That bash boundary binds new code. Scripts already over it",
      prose: "which script is new and which an issue rewrites is a judgement",
    },
    "32ed59a4": {
      quote: "Carried by the commands above:",
      prose: "a lead-in; each item below has its own entry",
    },
    "1547ba58": {
      quote: "One root `tsconfig.json` covers every tracked `.ts` outside",
      held: ["gate typecheck", "test scripts/typecheck-coverage.test.ts"],
    },
    "79ced6ec": {
      quote: "Every lint suppression says why on its own line: `//",
      held: ["gate check-lint-disables"],
    },
    "1c48ac57": {
      quote: "Carried by nobody, so hold them by hand:",
      prose: "a lead-in; each item below has its own entry",
    },
    fe467aaa: {
      quote: "Extensions are mandatory: `.ts`, `.tsx`, `.sh`. `tsgo`,",
      prose: "no check refuses a script with no extension; the gates skip it",
    },
    "04c96c9f": {
      quote: "Plugins are self-contained. No import crosses a plugin",
      prose: "no lint rule or test reads where an import points",
    },
    c7b55ea9: {
      quote: "Ship sources, never compiled binaries. `bun` is the runtime.",
      prose: "no check reads what a plugin ships",
    },
    b0a682fa: {
      quote: "Docs name symbols, sections and paths, never line numbers or",
      prose:
        "`scripts/check-frozen-facts.ts` finds versions and run ids, but no gate runs it; whether a number dates a measurement is a judgement",
    },
    "2212b2bf": {
      quote: "Keep documentation entry points as task indexes. Put each",
      prose: "what belongs on a page is a judgement",
    },
    "59fdda51": {
      quote: "A fact about the engine or the code cites the symbol or the",
      prose: "no tool tells a fact that was read from one that was guessed",
    },
    "4fd7f1a6": {
      quote: "A change of behaviour or of a data model, once a first",
      prose: "what changes a behaviour is a judgement",
    },
    "58eec70d": {
      quote: "Two symptom fixes on one feature: stop. Write the model",
      prose: "no tool sees that two fixes treat one cause",
    },
    "36ba8d0d": {
      quote: "One writer per worktree. The lead agent reads only until the",
      prose: "no hook knows which agent owns a worktree",
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
    "193dda83": {
      quote: "`dev` is the working trunk; `main` is the release channel",
      prose:
        "lefthook's `block-commit-to-main` and the agent-hooks landing guard refuse an agent's commit and push to `main`, but the fast-forward and the linear history are the GitHub rulesets', which no check of this repo reads",
    },
    c9751f1c: {
      quote: "Claude Code's built-in \"Commit or push only when the user",
      held: ["hook agent-hooks/agent-hooks.ts", "test agent-hooks/pre-bash.test.ts"],
    },
    b5f9452a: {
      quote: "Two lanes; the agent judges by scope, the user can override:",
      prose: "a lead-in; each lane below has its own entry",
    },
    "8706f9f1": {
      quote: "Inline — one concern, small diff: commit directly on `dev`.",
      held: ["hook scripts/check-e2e-green.ts"],
    },
    f78cbc4c: {
      quote: "Branch — several concerns, big work (large feature, large",
      prose: "the lane, the slices and when to rebase are judgements of scope",
    },
    c0d18f62: {
      quote: "Review: agents review each other's PRs; the human reviews",
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
      held: ["hook .claude/hooks/format-on-edit.ts", "test .claude/hooks/format-on-edit.test.ts"],
    },
    a361cf40: {
      quote: "`--fix` applies the fixes oxlint rates safe, never",
      prose: "oxlint rates its own fixes, and no repo check reads the rating",
    },
    b0298a8f: {
      quote: "The tools run from the checkout of the project's repository",
      held: ["test .claude/hooks/format-on-edit.test.ts"],
    },
    a34837a7: {
      quote: "Per-edit cost, measured on 2026-09-14 with hyperfine on",
      prose: "a measurement, kept with its conditions",
    },
    "29cf4b80": {
      quote: "The Stop and each subagent's SubagentStop are the",
      held: ["hook scripts/run-gates.ts", "test agent-hooks/stop.test.ts"],
    },
    "33ff07c7": {
      quote: "A new gate is one `EXPECTED_COMMANDS` entry in",
      held: ["gate lint-config"],
    },
    a8fa1170: {
      quote: "Tests stay out of Stop: every suite takes about 30 s here",
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
};
