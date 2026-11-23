/**
 * What holds each rule of the root `AGENTS.md` and of `.claude/rules/`, read by
 * `scripts/gates/check-rule-registry.ts` (the `rule-registry` gate). A rule is a text
 * block, headings and code aside: a paragraph, a top-level list item, a table
 * row. The key is a fingerprint of its text, so an edited rule loses its entry
 * and the gate names the new key. `held` names the controls that enforce what
 * the rule says is checked, each `<gate|hook|lint|test> <name>`; `prose` says
 * why no tool can. A paragraph's `covers: "list"` holds the list that follows
 * it; without it, each item has its own entry.
 */

import type { Registry } from "../scripts/gates/check-rule-registry.ts";

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
      held: ["hook scripts/gates/sync-versions.ts", "gate validate-marketplace"],
    },
    e720734e: {
      quote: "Agents never bump a version or write a `CHANGELOG.md`",
      held: [
        "hook scripts/releasing/check-plugin-bumps.ts",
        "test scripts/release.integration.test.ts",
      ],
    },
    "5b608160": {
      quote: "A behaviour change to a plugin is done once the `field-test`",
      prose: "whether a change alters behaviour is a judgement; no check knows a field test ran",
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
      held: [
        "gate lint-config",
        "hook scripts/gates/run-gates.ts",
        "hook scripts/gates/affected.ts",
      ],
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
      held: ["gate platform-copies"],
    },
    fa2b6c3a: {
      quote: "File, path and process code goes through the platform",
      held: [
        "lint local/no-raw-rename",
        "lint local/no-raw-write",
        "lint local/no-raw-git-spawn",
        "gate platform-copies",
      ],
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
        "the guard that refuses is Claude Code's own; this repo's Bash hook guards settings writes, not a command's shape",
    },
    "70ce207e": {
      quote: "A step that code can decide is done by the script or the",
      prose:
        "what code can decide is the judgement this rule asks for; the rule registry records it",
    },
    "6368aa86": {
      quote: "A commit message says what the code does and why, the reason",
      prose:
        "a model judges each message, through the prompt hook of `.claude/__settings.jsonc`; a control here names a script, and a prompt hook has none",
    },
    dbf56d05: {
      quote: "`archive/` - retired plugins, not in the marketplace.",
      prose: "a fact about the directory, no rule to hold",
    },
    "6573bd70": {
      quote: "`tools/oxlint/anti-slop/` - vendored lint plugin. Do not",
      held: ["gate lint-config"],
    },
    "926eba4d": {
      quote: "`scripts/` - the repo's own tooling, one directory per",
      prose: "a fact about the layout",
    },
    dda4d884: {
      quote: "`.github/factory/` - this repository's tier rules and their",
      prose: "a fact about the layout",
    },
    "667fb01a": {
      quote: "`tools/platform/` - the file, path and process helpers; edit",
      held: ["gate platform-copies"],
    },
    "32b88bf5": {
      quote: "`tools/oxlint/local/` - the repo's own lint plugin, edited",
      held: ["gate lint-config"],
    },
    "8245d841": {
      quote: "`dev` is the trunk and the repository's default branch;",
      prose:
        "lefthook's `block-commit-to-main` refuses a commit to `main` and the owner's global `guard-git-push` hook a push to it, but the pull request, its required checks, the fast-forward, the linear history and the signed commits are the GitHub rulesets', which no gate of this repo reads; `factory/scripts/check.ts` reports the required checks, the resolved threads, a bypass actor and the merge settings, not those rules",
    },
    "8ea9aebc": {
      quote: "Claude Code's built-in \"Commit or push only when the user",
      prose:
        "who commits and pushes where is a convention; the `guard-git-push` hook that refuses a push to `main` is the owner's machine's, outside this repository, which no check of it reads",
    },
    ce91a53a: {
      quote: "Two ways in, one gate:",
      prose: "a lead-in; each way below has its own entry",
    },
    "50e7a4fd": {
      quote: "An issue the owner labels `ready`: the factory starts a",
      prose:
        "`dispatch.yml` and the routine it fires run on GitHub and on claude.ai, where no gate of this repo reaches; `factory/scripts/check.ts` reports what they lack",
    },
    "30f260e6": {
      quote: "A session on the owner's machine: a `feature/`|`fix/` branch",
      prose:
        "which skill opens the pull request and how a stack is split are judgements; the ruleset is what refuses any other way into `dev`",
    },
    "548764ed": {
      quote: "During a feature the branch ignores `dev`. Bring `dev` in",
      prose:
        "when to bring the trunk in is a judgement of scope; `review.yml` is what stops a branch that was force-pushed",
    },
    "66801dd9": {
      quote: "Review: `review.yml` reviews each push of each pull request",
      prose:
        "the review, the gate and the label run on GitHub, where no gate of this repo reaches; `factory/scripts/tier.test.ts` holds the tier's computation on the template `.github/factory/tier.ts` was rendered from",
    },
    "6be8149c": {
      quote: "Before any push or release: follow [Repo",
      prose:
        "a procedure to follow; the owner's global `guard-git-push` hook refuses a push to `main`, outside this repository",
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
    "8c85baed": {
      quote: "The tools run from the checkout of the project's repository",
      held: ["test .claude/hooks/format-on-edit.integration.test.ts"],
    },
    "9fc8b124": {
      quote: "The Stop and each subagent's SubagentStop are the",
      held: ["hook scripts/gates/run-gates.ts", "test agent-hooks/stop.integration.test.ts"],
    },
    "8a944844": {
      quote: "A new gate is one `EXPECTED_COMMANDS` entry in",
      held: ["gate lint-config"],
    },
    d9b94800: {
      quote: "Tests stay out of Stop: the suites of both tiers take far",
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
    "1f0dedd2": {
      quote: "A skill whose effect leaves the machine or rewrites history",
      prose:
        "whether an effect can be undone is a judgement; the leads skills' writes are scripts/leads/'s, to which scripts/leads/guard.test.ts holds their hook",
    },
  },
  ".claude/rules/test-tiers.md": {
    "4f8e006e": {
      quote: "A test file that starts a process (`git`, `bun`, a CLI, a",
      prose: "whether a test starts a process is known only by running it",
    },
  },
};
