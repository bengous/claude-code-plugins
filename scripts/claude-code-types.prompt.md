You run unattended, in a worktree made for you: `{{worktree}}`, on the branch `chore/claude-code-types`. Nobody answers questions during this run: decide, and write down what you decided and why.

Claude Code moved from {{from}}, the version whose plugin API types `origin/dev` carries, to {{to}}, the installed one. The script that started you regenerated those types for {{to}}: `vellum/types/claude-code.d.ts` and `vellum/types/claude-code-tools.d.ts` are modified and uncommitted. `git diff origin/dev -- vellum/types/` shows everything that changed over the whole range, earlier commits of this branch included.

{{rebase}}

Your job: find out whether this update affects the repository's hooks modules ({{modules}}), and land the changes it calls for as commits on this branch.

1. Commit the regenerated types first, alone: `chore(vellum): types from Claude Code {{to}}`. If the pre-commit typecheck refuses that commit, the update broke a module: fix the break in that same commit.
2. For each hooks module, judge the diff: what breaks, what behaves differently (often said only in the types' doc comments), what new API the module could use. Each finding names the symbol in the types and the module's `file:line` it concerns. A module the update leaves untouched is still reported, as no impact.
3. Make the changes worth making, one commit per change, following `AGENTS.md` and the rules it points to. The types commit alone bumps nothing: the release guard (`scripts/check-plugin-bumps.ts`) asks the human for that bump at release time. A commit that changes a plugin's code also brings that plugin's version bump and its `CHANGELOG.md` section, once for the branch. A change too large for this branch, or one that needs a human decision, becomes a GitHub issue instead (the `github-flow:issue` skill), linked from the pull request body.
4. Leave the gates green: `bun ./scripts/run-gates.ts` and `bun ./scripts/affected.ts test`. Leave nothing uncommitted.
5. Write the pull request body to `{{body}}`, in the shape the `github-flow:pr` skill gives a body: the range {{from}} → {{to}} first, then one impact table per module (finding, symbol, `file:line`, verdict, what this branch does about it), the commits, the issues opened, and what you could not measure. Say whether the branch bumps a plugin or leaves the types unbumped for the release guard.

{{previous}}

Do not push, and do not open or edit the pull request: the script does both once you exit, and it checks first that the worktree is clean, that `HEAD` carries the types of {{to}}, and that the body is written. Everything you write into the repository, the pull request body and any issue is in English.
