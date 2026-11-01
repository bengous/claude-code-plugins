# Platform helpers

The file, path and process helpers of the whole repository, in one source. A plugin stands alone
once installed, so it never imports this directory: it imports its own copy, which
`scripts/sync-platform.ts` writes and holds identical. `scripts/` and `.claude/` import this
directory directly.

| File | Holds | Imports |
|---|---|---|
| `pure.ts` | quoting, errno, messages, lexical paths | nothing, and names no `Bun`, `process` or `NodeJS`: a mod imports it by value |
| `fs.ts` | writes, renames, exclusive creation | `node:fs`, `node:path`, Bun, `./pure.ts` |
| `lock.ts` | the lock | `node:fs`, Bun, `./fs.ts`, `./pure.ts` |
| `process.ts` | processes, the environment overlay | `node:os`, Bun, `./pure.ts` |
| `git.ts` | git | `./process.ts` |
| `consumers.ts` | the copies' directories | nothing |

A mod runs in Claude Code's engine, which has no Node, no `process` and no `Bun`
([Hook tests](../../docs/plugin-testing/hooks.md)): a directory whose code runs only in mods
imports `pure.ts` alone, so its copy holds `pure.ts` alone.

## Why copies, not a package

Claude Code installs a marketplace plugin by copying its directory alone into its cache, so an
import that leaves the plugin finds nothing once installed
([In-place and copied plugins](https://code.claude.com/docs/en/plugins/loading#in-place-and-copied-plugins)).
Each way to share code without a copy fails a target this repository has:

- **An npm package.** Claude Code installs a plugin's `package.json` dependencies when it caches
  it, but the helpers would need a registry and releases of their own, every consumer a
  `package.json` and a `bun.lock`, and a plugin loaded in place gets no install
  ([Node.js package dependencies](https://code.claude.com/docs/en/plugins/loading#node-js-package-dependencies)).
- **A plugin dependency.** `dependencies` in `plugin.json` installs and enables another plugin, and
  gives no path to its files ([Plugin dependencies](https://code.claude.com/docs/en/plugins/dependencies)).
- **A symlink inside the plugin.** Dereferenced when Claude Code copies a plugin from a git
  marketplace, but skipped from a local-path one
  ([Share files with symlinks](https://code.claude.com/docs/en/plugins/host-marketplace#share-files-within-a-marketplace-with-symlinks));
  on Windows a symlink needs Developer Mode, and Git for Windows checks one out as a plain file
  unless `core.symlinks` is on. vellum and the `win32` CI job target Windows.

## Copies

- `consumers.ts` lists the directory of each copy: `<owner>/lib/platform` or
  `<owner>/src/platform`, its owner a directory at the root.
- A copy holds the modules its owner's files import from it, then the modules those import:
  `git.ts` brings `process.ts`, `lock.ts` brings `fs.ts`, each brings `pure.ts`. An edit to a
  module changes only the copies that hold it, so only their plugins ship a new version. An import
  marked `type` counts, since the typecheck reads that file too; the transpiler drops it, so the
  gate reads each path quoted after `from`, `import` or `require` in the text, a comment's
  included.
- Edit this directory, never a copy, then run `bun ./scripts/sync-platform.ts --write`: it writes
  each module a copy must hold that differs or is missing, and removes what git lists in a copy
  beyond them. A file git ignores there (a scratch `.tmp`, a `.DS_Store`) is left alone.
- `bun ./scripts/sync-platform.ts`, the gate `platform-copies`, writes nothing and refuses:
  - a copy that differs from its source, byte for byte, or is a symbolic link, which a plugin
    installed alone loses;
  - a module a copy must hold that it lacks or git ignores, or a file git lists there that no
    import brings;
  - an import, into a copy, of a file this directory does not hold;
  - a consumer whose owner does not exist, a directory of another form or listed twice, or one
    whose copy nothing in its owner imports;
  - a `lib/platform/` or `src/platform/` directory `consumers.ts` does not list;
  - a value import, from a catalog plugin, its source at any depth, or a consumer's owner, that
    resolves outside that directory: into another plugin, `scripts/`, `.claude/` or `tools/platform/`
    (`Bun.Transpiler.scanImports`, so an import marked `type` passes, while an unmarked import
    used only as a type counts).
- The tests stay here and run against the source: a mod's kit collects every `*.test.ts` under its
  plugin, so no test is copied.

## `pure.ts`

| Helper | Contract |
|---|---|
| `shellQuote(value)` | One POSIX shell word: always single-quoted, each `'` written `'\''`. |
| `errnoOf(cause)` | The errno of a thrown value: its `code` when the error carries one, else the `E…` a mod's `$.fs` ends its message on (`… failed: ENOENT`); `null` for neither, and for anything not an `Error`. |
| `isErrno(cause, ...codes)` | Whether `errnoOf(cause)` is one of `codes`. |
| `messageOf(cause)` | An error's `message`, anything else through `String`. |
| `isInsideRelative(rel, seps)` | Whether a relative path stays under its root: `""` (the root itself) and `..env` do; a whole `..` segment anywhere, or an absolute path, does not. `seps` are passed explicitly, since on POSIX `\` is part of a name: `[sep]` for `node:path`'s answer, `["/", "\\"]` for a path that may hold either. With `\` among them, a drive letter followed by a separator is absolute. |
| `isUnder(root, path, sep)` | Whether `path` lies under `root`, lexically: past a separator boundary (`/a` holds `/a/b`, not `/ab`), with no `..` segment anywhere in `path`. The root is not under itself: a caller that counts it adds `path === root`. |
| `baseNameOf(path)` | What follows the last `/` or `\`; the whole path when it holds neither. |
| `dirNameOf(path)` | What precedes the last `/` or `\`, `/` when that separator leads the path; `null` when it holds neither. |

## `fs.ts`

| Helper | Contract |
|---|---|
| `isHeld(cause)` | Whether Windows refused a rename because a program holds the file or folder: `EBUSY`, `EPERM` or `EACCES` on `win32`; always `false` elsewhere, where a held folder renames and an `EPERM` is a real refusal. |
| `rename(from, to, { heldRetryMs })`, `renameSync` | `node:fs`'s rename, tried again every 100 ms for `heldRetryMs` (`0` by default) while `isHeld` says Windows holds it; any other failure is thrown at once. |
| `writeAtomic(file, data, { mkdir, heldRetryMs })`, `writeAtomicSync` | Writes `data` (`string` or `Uint8Array`) to `.<base>.<pid>.<uuid>.tmp` beside `file`, then renames it over `file` through `rename`: a reader meets the old content or the new, whole, and two writers never rename each other's scratch file. The scratch file is removed when the write or the rename fails. `mkdir` creates the directory first. No fsync: it guards against a process crash and concurrent writers, not a power loss. The rename replaces what `file` was: a symbolic link becomes a file, and the mode is the new file's default (an executable bit is lost), so a file whose link or mode matters is written in place. |
| `createExclusiveSync(file, data)` | Creates `file` unless it exists: the data goes to a scratch file beside it, which is linked into place and removed in any case. `true` when created, `false` on `EEXIST` with `file` untouched; any other failure is thrown. |

## `lock.ts`

| Helper | Contract |
|---|---|
| `withLock(lockFile, fn, { timeoutMs })` | Creates `lockFile` exclusively (`wx`) holding `<pid> <ISO date>`, runs `fn`, and removes the lock once `fn` settles, thrown or not. While another holds it, or on Windows while the file a holder removed is pending deletion, it tries again every 50 ms up to `timeoutMs`, then throws naming the file, the holder's pid and the lock's age; a lock let go of at that moment is tried once more instead. Any other refusal to create the file is thrown at once with its errno; on Windows, where a real refusal reads as a pending deletion, it is thrown at `timeoutMs`, once no lock file is left to read. A lock its holder left behind is never taken over: the error says to remove it. |

## `process.ts`

| Helper | Contract |
|---|---|
| `run(argv, options)`, `runSync` | Runs `argv` to its end, its output captured, and answers `exited { code, stdout, stderr }`, `timedOut { timeoutMs, stdout, stderr }` or `missing { program }`. Options: `cwd` (this process's by default); `env`, laid over this process's environment, which the child gets in full otherwise, entry by entry: a value sets a variable, `undefined` removes it, and each entry replaces the same name before it, the overlay's own included, in any case on Windows; `timeoutMs`, none by default, a timeout killing the process with `SIGKILL`, and `<= 0` answering `timedOut` without starting it (Bun reads `timeout: 0` as none); `stdin`, a `string` or a `Uint8Array`; `stdout: "buffer"`, which answers stdout as a `Buffer`. `missing` answers one case alone, Bun's "Executable not found", a bare name the PATH does not hold: a path to no program (`/x/prog`, `./prog`) on POSIX, a program it may not run (`EACCES`) and a missing `cwd` throw a `LaunchError`, which keeps Bun's message, Bun's error as `cause` and its errno as `code` (`errnoOf` reads it), and Bun's message for a missing `cwd` names the program, not the directory. Any other throw, a pipe's read that fails, is no `LaunchError`. `run` reads a timeout off the kill signal (`signalCode === "SIGKILL"`) once `timeoutMs` has passed, since an async process carries no timeout flag: a `SIGKILL` from outside before then is an exit. It waits for the output at most 1 s (`OUTPUT_GRACE_MS`) after the exit, then lets go of the pipes, which a killed shell's children may hold on POSIX: neither the grace nor those children keep the calling process alive. Past the grace, stdout and stderr are both empty, even when one pipe had delivered its bytes, and the `exited` or `timedOut` result carries `outputLost: true`; the field is absent otherwise. `runSync` reads Bun's own timeout flag, has no grace, so never sets `outputLost`, and reports a process a signal ended with code 128 plus the signal's number, as `run` does. Both read text output as UTF-8 with a leading BOM dropped. Every process starts with `windowsHide`. |
| `overlaid(base, overlay)`, `sameName(a, b)`, `spawnAsyncAs(argv, options, env)`, `spawnSyncAs` | What `git.ts` builds its environment with: the overlay `run` lays over this process's environment, the name match it uses, case-blind on Windows, and `run` and `runSync` taking `env` as the child's whole environment. |

## `git.ts`

| Helper | Contract |
|---|---|
| `git(args, options)`, `gitSync` | Runs git through `run`, its output raw, untrimmed, a failure an `exited` result, `outputLost` kept: a call that reads the code alone, as a `clone` whose ssh master (`ControlPersist`) keeps stderr open, reads it as is. A git missing from the PATH throws a `GitMissingError` (`git is not on the PATH`). `cwd` is an option; a call that names its repository with `-C` keeps it in `args`. Options beyond `run`'s, all opt-in: `cLocale` sets `LC_ALL=C`; `scrubGitEnv` leaves out every `GIT_*` variable of this process's environment before `env` is laid over it, `GIT_CONFIG_GLOBAL` among them; `config` passes each `key=value` as `-c` before `args`. A call that removes some variables only, as `.claude/hooks/checkout.ts` removes what `git rev-parse --local-env-vars` lists, names each as `undefined` in `env`. |
| `gitRead(args, options)`, `gitReadSync` | A git command that must succeed: its stdout trimmed at both ends, or with `raw: true` as git wrote it, for an output whose columns matter, as `status --porcelain` leads a line with a space. The options are `git`'s, `stdout` aside. Any other end throws a `GitError` whose message is `git <args> failed (exit <code>): <stderr trimmed>`, or `git <args> timed out after <n> ms: <stderr trimmed>`; an output `run` let go of throws too, even on an exit 0, as `git <args> exited <code>, its output let go of after 1000 ms` (`timed out after <n> ms, its output …` for a timeout), since its stdout is empty, not what git wrote. `gitReadSync` has no grace, so never throws for it. |

## What the lint holds

Two rules, `local/no-raw-rename` and `local/no-raw-git-spawn` (`tools/oxlint/local/`), report a
`rename` from `node:fs` and a git spawned by hand outside this directory, its copies and the tests,
wherever `oxlint.config.ts` sets them to `error`. They are the only guarantee that code goes
through these helpers: no rule sees a hand-written shell quote, errno test, error message, path
check or in-place write, so those families use the helpers by review alone.
