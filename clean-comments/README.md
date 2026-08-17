# Clean Comments Plugin

Audit and clean code comments. Protects the comments that carry a why or a constraint,
and hunts the ones that lie.

## Why it exists

Two problems hide under "too many comments". The cheap one is noise: a comment that
restates the line below it. The expensive one is a comment that LIES — a path that
moved, a count that grew, a "TEMPORARY" that shipped, a "stubbed" the code refutes. It
sends the next reader, human or agent, toward a wrong decision.

A grid that only asks "does this restate the code?" never catches the second kind. This
plugin judges truth as well as usefulness.

## Skill: clean-comments

```bash
/clean-comments:clean-comments              # branch diff vs merge-base, audit only
/clean-comments:clean-comments src/**/*.ts  # a file pattern
/clean-comments:clean-comments --diff       # only what git diff shows
/clean-comments:clean-comments --apply      # apply approved items
```

Four actions:

| The comment... | Action |
|---|---|
| Compensates for a bad name, a missing abstraction, a magic number | **REFACTOR** |
| Carries a why, an external constraint, a trap, a proof, an interface contract, or a higher-level summary of a block or module | **KEEP** |
| Restates the code, or is a decorative banner | **REMOVE** |
| Makes a checkable factual claim | **FIX-VERIFY** |

**FIX-VERIFY** is the action classic grids lack. A comment citing a path, a count, a
state, or a list of consumers is making a claim: check it before judging it. Checks
split in two cost levels: level M (mechanical, one command — a cited path, a cited
symbol) is open to hunters; level S (semantic — counts, dated states, consumer lists)
belongs to the strong arbitration pass alone. In audit mode the skill reports the
claim with its counter-proof and never rules alone.

Audit mode is read-only. Apply mode runs only on approved items. The two never mix in
one pass.

Fan-out runs under a hard budget: batches sized by content volume (~200k tokens per
hunter), at most 4 hunters at a time, and a confirmation guard before any scope past
~1M tokens. A hunter never spawns a subagent.

## Agent: comment-hunter

For a repo-wide hunt, the skill fans out `comment-hunter` agents over batches of files.
Each hunter reads its batch in full, classifies every comment, flags stale suspects
without ruling on them, and writes its report fragment to a path given in its prompt —
so the detail lands verbatim on disk and the orchestrator's context stays light.

A repo can override the hunter with its own `.claude/agents/comment-hunter.md` for
house style, working language, or a local survives/dies map.

## Probe: check-cited-paths.ts

```bash
bun skills/clean-comments/scripts/check-cited-paths.ts <repo-root> [options]
```

Whether a cited path exists is a fact, not an opinion, so a script settles it across
the whole repo in milliseconds instead of spending an agent's context on it. Always
exits 0 and writes nothing: an audit probe, not a gate.

| Option | Meaning |
|---|---|
| `--ext <list>` | extensions of files to scan |
| `--cited-ext <list>` | extensions accepted inside a citation |
| `--exclude <dir>` | directory to skip, repeatable |
| `--root <path>` | extra resolution root, repeatable |
| `--external <regex>` | citation to ignore, repeatable (paths outside the repo by design) |
| `--count` | comment-line counts per file instead of checking citations |

A citation is cleared as soon as it resolves against the repo root, any ancestor
directory of the citing file, any directory down to depth 3, or a `--root` you passed.
Blind spots it leaves to the reading agent: a bare filename with no directory, and
paths inside hidden directories.

## Installation

Part of the `bengous-plugins` marketplace.

```json
{
  "enabledPlugins": ["clean-comments@bengous-plugins"]
}
```

Or:

```bash
/plugin install clean-comments@bengous-plugins
```

## License

MIT
