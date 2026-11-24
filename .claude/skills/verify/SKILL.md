---
name: verify
description: "Verify a change to this repository by running it: the suites and the gates the change reaches, then the changed thing itself, a hook fed its input, a script run on a case, a hooks module's kit, a server answering a request. Use when a change is about to be pushed or reported done, before a pull request is opened, and again after any later edit."
---

# Verify a change

A passing suite says the tests pass. Verifying means the changed thing ran and did what the change says. Do both, in this order, from the repository's root.

## 1. Install

In a fresh clone:

```bash
bun install --frozen-lockfile
```

Before a change under `vellum/`, `pinpoint/` or `atlas/`, that plugin's own dependencies too, `<plugin>` being its directory:

```bash
bun install --cwd <plugin> --frozen-lockfile --ignore-scripts
```

An install the network refuses is a blocker to name, not a step to skip: the suites below need it.

A cloud session clones shallow, and the release tests read the history (`vellum/CHANGELOG.md > has one section for each version its history set`). When this prints `true`:

```bash
git rev-parse --is-shallow-repository
```

complete the clone before the suites:

```bash
git fetch --unshallow origin
```

## 2. The suites and the gates the change reaches

```bash
bun ./scripts/gates/run-gates.ts
```

```bash
bun ./scripts/gates/affected.ts test
```

`run-gates.ts` prints nothing when every gate passes. `bun ./scripts/gates/affected.ts print` shows which units the change reaches. Both measure from `origin/dev`: fetch it first when the clone is old.

## 3. Run the changed thing

Scratch files go in a directory `mktemp -d` prints, never in the repository.

| What changed | Run it | A good result |
|---|---|---|
| A hook script, a plugin's or one under `.claude/hooks/` | Write the JSON Claude Code would send it to a scratch file (its tests hold examples), then `bun <hook> < <scratch file>`, or `bash <hook> <arguments> < <scratch file>` | The exit code and the output the change means: 0 and no output when it lets the call through, 2 and its message on stderr when it blocks |
| A script or a CLI, under `scripts/` or in a plugin | Run it on a case the change is about, in a scratch git repository when it reads or writes one, with its `--dry-run` when it has one | The output the change means. Never run it against GitHub or against `origin`: a script that pushes, tags, labels or comments is verified by its tests and its dry run alone |
| A hooks module: `vellum`, `todos`, `secret-pane`, `pinpoint`, `atlas`, `griller` | `claude plugin validate <plugin>`, then `claude plugin test <plugin>` | Both exit 0 |
| A server or its page: `vellum`, `pinpoint`, `atlas` | Start it as the plugin's `AGENTS.md` or `README.md` says, request the changed route with `curl` | The response the change means. A change to what a page shows is checked by vellum's browser suite, `bun run --cwd vellum e2e -- --project=light-1440`, once `bun run --cwd vellum e2e:install` has installed Chromium; where that install fails, the pull request's `e2e` job is the check: say so |
| The text of a skill, a command, an agent or a rule | `bun ./scripts/gates/validate-frontmatter.ts --all`, then run once, as written, each command the text tells the model to run that writes nothing outside the clone | The gate exits 0 and each command runs as the text says |
| A workflow under `.github/workflows/` | Nothing runs it here | `none`: the pull request's own checks run it |
| Documentation alone | Nothing to run | `none` |

## 4. What this cannot show

A panel, a band, a toast, a skill's flow in a live session and anything in Claude Desktop need a live session: the `field-test` skill plays them on the owner's machine, with tmux and the desktop app, which a cloud session has not. For a change to one of those, name it under **Checks** as not played in a session.

A cloud session's container fails some tests the code passes on CI and on the owner's machine. `affected.ts test` stops at its first red run, so where the change reaches them, run the next runs by hand to get their numbers. Under **Checks**, name each of these as not run in the container, by its cause, beside the rest of the run's numbers; the pull request's `test` job runs them.

| The container | Fails | As |
|---|---|---|
| has no IPv6 | `scripts/ci/mutation.integration.test.ts` under `a pass leaves the checkout as it found it`, two tests; `pinpoint/server/serve.integration.spec.ts`, the `[::ffff:127.0.0.1]` address | the 60 s budget, at any budget: Stryker's server cannot listen on `::`; 502 for 508 |
| runs as root, past every file mode | the tests of a file or a folder the process cannot read, write or rename: vellum's `fs.spec.ts`, `queue.spec.ts` and `preview.integration.spec.ts` (`draft`), atlas's `cli.integration.spec.ts` and `inventory.integration.spec.ts`, pinpoint's `a seq that does not read` | a read or a write that succeeds where the test made it fail |
| has a PID 1 that reaps no orphan | `agents-bridge/scripts/codex-run.integration.test.ts`, `cancel also stops the commands codex started` | the killed child left a zombie, which still answers a signal 0 |

A session that starts with a message from `cloud-tools.sh` runs in an environment that did not run `.github/factory/setup.sh` as the clone holds it, or whose tool install failed: quote the message under **Checks**, and name there each test or gate the missing tool kept from running.

## 5. Report

Under **Checks** in the pull request body: each command run and its result, with numbers (tests passed, exit codes), and what section 4 left unplayed. For a change with nothing to verify, `none` and why.
