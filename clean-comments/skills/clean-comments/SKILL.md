---
name: clean-comments
description: >
  Audit and clean code comments with four actions: REFACTOR (comment compensates for
  unclear code), KEEP (why / external constraint / trap), REMOVE (paraphrase, decorative
  banners), FIX-VERIFY (factual claim checked against the code). Protects why and
  constraint comments; hunts comments that lie — stale cited paths, wrong hard-coded
  numbers, guarantees the code refutes. Use when the user wants to clean, audit, review
  or deslop comments, remove comment slop, or suspects stale or misleading comments.
argument-hint: "[file-pattern | --diff] [--apply]"
model: opus
allowed-tools:
  - Read
  - Grep
  - Glob
  - Edit
  - Bash(git:*)
  - Bash(rg:*)
  - Bash(bun:*)
---

# Clean Comments

<context>
Two different problems hide under "too many comments".

The cheap one is noise: a comment that restates the line below it. It wastes a
reader's second, nothing more.

The expensive one is a comment that LIES: a path that moved, a count that grew, a
"TEMPORARY" that shipped, a "stubbed" the code refutes. It sends the next reader —
human or agent — toward a wrong decision. On a real audit it outnumbered pure
paraphrase in cost by a wide margin, and no grid that only asks "does this restate
the code?" ever catches it.

So this skill judges truth as well as usefulness, and it protects the comments that
carry a why or a constraint — those are an asset, not debt.
</context>

<constraints>
- Never remove a why comment or a constraint comment. When uncertain, keep.
- Audit mode NEVER edits a file. Apply mode only runs on approved items.
- Never confirm a comment stale without evidence. Report the claim and the
  counter-proof that settles it.
- Never clean a file slated for rewrite. Signal it; the cleanup would be thrown away.
- Never refactor code during an audit, even when a comment begs for it. Say what to
  extract in one line and move on.
- Decorative banners alone never justify a dedicated cleanup pass. They are cosmetic.
</constraints>

## The bar

> A comment earns its place if it says what the code cannot: a why, an external
> constraint, a trap, a proof. A paraphrase of the line below is slop.

## Decision grid

| The comment... | Action |
|---|---|
| Compensates for a bad name | **REFACTOR** — rename, drop the comment |
| Compensates for a missing abstraction | **REFACTOR** — extract a well-named function |
| Explains a magic number | **REFACTOR** — extract a named constant |
| Carries external knowledge (business rule, browser quirk, RFC, incident) | **KEEP** |
| Carries a trap, an invariant, an order dependency, a "DO NOT" | **KEEP** |
| Carries a decision, a rejected alternative, an arbitration | **KEEP** |
| Restates the code, or is a decorative banner | **REMOVE** |
| Makes a checkable factual claim | **FIX-VERIFY** — check it before you judge it |

**FIX-VERIFY** is the action the classic grid lacks. A comment that cites a file path,
a count, a state ("stubbed", "temporary", "not yet"), a symbol, or a list of consumers
is making a claim about the code. Check the claim first:

- The claim holds → it is a KEEP (or a REMOVE on its own merits).
- The claim fails → the comment lies. In audit mode, report it as a stale suspect with
  the exact sentence and the counter-proof. In apply mode, correct or delete it.

Examples of each action:

```
REFACTOR   let d;                 // days until due      → rename to daysUntilDue
REFACTOR   x * 86400000           // ms per day          → const MS_PER_DAY
KEEP       // FCC requires 30-day retention
KEEP       // Order matters: auth before session
KEEP       // Safari bug, see webkit#12345
REMOVE     i++;                   // increment i
REMOVE     // ───────────────  /* ===== Helpers ===== */
REMOVE     commented-out code blocks (git history holds them)
FIX-VERIFY // Sending is STUBBED   → the code posts for real
FIX-VERIFY // see src/data/menus.ts → the file moved to contracts/
FIX-VERIFY // the 16 redirects      → there are 23 now
```

## Cross-cutting annotation: replaceable-by-code

Independent of its action, mark a comment when a code change would make it
unnecessary:

- A hard-coded number that should be derived. Fixing the sentence repairs nothing —
  it goes stale again at the next change.
- A magic number that calls for a named constant.
- A name so vague that the comment does the naming for it.

State what to extract or derive, in one line. Do not do it: touching code is another
workstream, with its own review.

## Modes

**Audit** (default) — read-only. Classify, verify, report. No edits.

**Apply** (`--apply`, or explicit user confirmation of an audit) — execute approved
items only.

Never mix the two in one pass. An audit that edits as it goes cannot be reviewed.

## Scope

Parse `$ARGUMENTS`:

- A file pattern → those files.
- `--diff` → judge only comments visible in `git diff -U20`, without reading whole
  files. Cheap, good for a pre-commit review.
- Neither → recently changed files (`git diff --name-only HEAD~5`).
- `--apply` → apply mode (see above).

Ask the user for a survives/dies map when the repo has a rewrite in flight, or accept
one they volunteer.

## Workflow

### Step 1: Mechanical pre-pass

Run the probe before any judgment:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/clean-comments/scripts/check-cited-paths.ts <repo-root>
```

Whether a cited path exists is a fact, not an opinion — a script settles it across the
whole repo in seconds, and a fact does not need an LLM. Feed the output into the rest
of the pass:

- A broken citation is a stale suspect whose counter-proof is already done.
- A resolved citation is innocent; do not re-check it by hand.

Blind spots the probe does not cover, and you must: bare filenames with no directory,
paths inside hidden directories, and paths relative to a project area the probe did not
derive (pass `--root` for those). Read `--help` for the flags.

### Step 2: Classify

For every comment in scope, apply the grid. Order the tests:

1. **Deletion test** — delete it: is anything lost that the code does not say? No →
   REMOVE (paraphrase). Decorative banners fail this test by definition.
2. **Why test** — does it carry a decision, a rejected alternative, an arbitration?
   Yes → KEEP.
3. **Trap test** — does it carry an external constraint, an invariant, a proof, a past
   incident, a "DO NOT"? Yes → KEEP, even if it reads long-winded.
4. **Truth test** — does it claim something checkable? → FIX-VERIFY.

When torn: trap > why > paraphrase. A comment that is half useful and half chatty is
classed on its useful half.

### Step 3: Verify the claims

Read-only checks, in the order to reach for them:

| Claim | Check |
|---|---|
| Cited path | Probe output from step 1 |
| Hard-coded count | Recount the real thing: `bun -e 'import { X } from "./m.ts"; console.log(Object.keys(X).length)'` |
| Cited symbol or constant | `rg -n "SYMBOL" <area>` — zero hits outside the comment itself is a suspect |
| Dated state ("temporary", "not yet", "in phase 2") | `git log --oneline -3 -- <file>` and `git log -S "fragment of the sentence" --oneline` |
| Any occurrence count | `rg -o "pattern" <file> \| wc -l` — never `grep -c`, which counts lines, not occurrences |

Nothing that writes: no `sed -i`, no `>` redirection, no `git add`/`commit`/`checkout`.

### Step 4: Scale the hunt

Small scope (a handful of files) → do it inline.

Large scope (a whole repo, dozens of files) → fan out `comment-hunter` agents over
batches. Give each hunter:

- Its batch: absolute path, comment-line count (its denominator), fate tag
  (`survives` / `dies` / `dies-partial` / `unknown`) when a map exists.
- The probe output lines that concern its batch.
- A report path on disk to write its fragment to.

Each hunter writes its full deliverable to that path and answers in three lines. The
detail lands verbatim, your context stays light. Then run one strong arbitration pass
over the collected suspects only — the hunters' VERIFIED-OK sections already cleared
the rest.

### Step 5: Report

Group by file, actions in this order: FIX-VERIFY, REFACTOR, REMOVE, KEEP.

```
## src/billing.ts

### FIX-VERIFY (1)
- L4: "Sending is STUBBED" — refuted: wizard.ts:620 posts to /api/orders

### REFACTOR (2)
- L45: `let d; // days until due` → rename d to daysUntilDue
- L89: `* 86400000 // ms per day` → const MS_PER_DAY [replaceable-by-code]

### REMOVE (2)
- L23: `return result; // return the result` — restates the code
- L60-64: decorative banners

### KEEP (2)
- L34: GDPR Article 17 — legal requirement
- L156: setTimeout needed, direct call races

Summary: 1 lie, 2 refactors, 2 removals, 2 kept.
```

Then ask which items to apply. In apply mode, execute approved items only: corrections
and deletions first, renames and extractions after, KEEP items untouched.

## Extension points

A repo can override the vendored hunter with its own
`.claude/agents/comment-hunter.md`: house bar, working language, local vocabulary,
its own fate map. The skill supplies the mechanism, not the house style.

Claude Code watches the agent directories and picks up an edited agent file within
seconds — but only for directories that existed when the session started. Create
`.claude/agents/` during a session and the override stays invisible: the invocation
silently falls back to a general-purpose agent. Either restart the session, or start
the subagent prompt with "read <path to the .md> first and follow it to the letter".
