# Platform helpers

The file, path and process helpers of the whole repository, in one source. A plugin stands alone
once installed, so it never imports this directory: it imports its own copy, which
`scripts/sync-platform.ts` writes and holds identical. `scripts/` and `.claude/` import this
directory directly.

| File | Holds | Imports |
|---|---|---|
| `pure.ts` | quoting, errno, messages, lexical paths | nothing, and names no `Bun`, `process` or `NodeJS`: a mod imports it by value |
| `node.ts` | writes, renames, the lock, processes, git | `node:fs`, `node:path`, `node:os`, Bun, `./pure.ts` |
| `consumers.ts` | the copies: `{ dir, files }` each | nothing |

A mod runs in Claude Code's engine, which has no Node, no `process` and no `Bun`
([Hook tests](../../docs/plugin-testing/hooks.md)): a directory whose code runs only in mods copies
`pure.ts` alone.

## Copies

- `consumers.ts` lists each copy: `dir` is `<owner>/lib/platform` or `<owner>/src/platform`, its
  owner a directory at the root; `files` names `pure.ts` alone, or `pure.ts` and `node.ts`, which
  imports `./pure.ts`.
- Edit this directory, never a copy, then run `bun ./scripts/sync-platform.ts --write`: it writes
  each listed file that differs or is missing, and removes what git lists in a copy beyond its
  list. A file git ignores there (a scratch `.tmp`, a `.DS_Store`) is left alone.
- `bun ./scripts/sync-platform.ts`, the gate `platform-copies`, writes nothing and refuses:
  - a copy that differs from its source, byte for byte, or is a symbolic link, which a plugin
    installed alone loses;
  - a listed file a copy lacks or git ignores, or a file git lists there beyond its list;
  - a consumer whose owner does not exist, a `dir` of another form, or a list without `pure.ts`;
  - a `lib/platform/` or `src/platform/` directory `consumers.ts` does not list;
  - a value import, from a catalog plugin or a consumer's owner, that resolves outside that
    directory: into another plugin, `scripts/`, `.claude/` or `tools/platform/`
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

## `node.ts`

| Helper | Contract |
|---|---|
| `isHeld(cause)` | Whether Windows refused a rename because a program holds the file or folder: `EBUSY`, `EPERM` or `EACCES` on `win32`; always `false` elsewhere, where a held folder renames and an `EPERM` is a real refusal. |
| `rename(from, to, { heldRetryMs })`, `renameSync` | `node:fs`'s rename, tried again every 100 ms for `heldRetryMs` (`0` by default) while `isHeld` says Windows holds it; any other failure is thrown at once. |
| `writeAtomic(file, data, { mkdir, heldRetryMs })`, `writeAtomicSync` | Writes `data` (`string` or `Uint8Array`) to `.<base>.<pid>.<uuid>.tmp` beside `file`, then renames it over `file` through `rename`: a reader meets the old content or the new, whole, and two writers never rename each other's scratch file. The scratch file is removed when the write or the rename fails. `mkdir` creates the directory first. No fsync: it guards against a process crash and concurrent writers, not a power loss. The rename replaces what `file` was: a symbolic link becomes a file, and the mode is the new file's default (an executable bit is lost), so a file whose link or mode matters is written in place. |
| `createExclusiveSync(file, data)` | Creates `file` unless it exists: the data goes to a scratch file beside it, which is linked into place and removed in any case. `true` when created, `false` on `EEXIST` with `file` untouched; any other failure is thrown. |
| `withLock(lockFile, fn, { timeoutMs })` | Creates `lockFile` exclusively (`wx`) holding `<pid> <ISO date>`, runs `fn`, and removes the lock once `fn` settles, thrown or not. While another holds it, or on Windows while the file a holder removed is pending deletion, it tries again every 50 ms up to `timeoutMs`, then throws naming the file, the holder's pid and the lock's age; a lock let go of at that moment is tried once more instead. A lock its holder left behind is never taken over: the error says to remove it. |
| `run(argv, options)`, `runSync` | Runs `argv` to its end, its output captured, and answers `exited { code, stdout, stderr }`, `timedOut { timeoutMs, stdout, stderr }` or `missing { program }`. Options: `cwd` (this process's by default); `env`, laid over this process's environment, which the child gets in full otherwise, entry by entry: a value sets a variable, `undefined` removes it, and each entry replaces the same name before it, the overlay's own included, in any case on Windows; `timeoutMs`, none by default, a timeout killing the process with `SIGKILL`, and `<= 0` answering `timedOut` without starting it (Bun reads `timeout: 0` as none); `stdin`, a `string` or a `Uint8Array`; `stdout: "buffer"`, which answers stdout as a `Buffer`. `missing` answers one case alone, Bun's "Executable not found", a bare name the PATH does not hold: a path to no program (`/x/prog`, `./prog`), a program it may not run (`EACCES`) and a missing `cwd` are thrown, and Bun's error for a missing `cwd` names the program, not the directory. `run` reads a timeout off the kill signal (`signalCode === "SIGKILL"`) once `timeoutMs` has passed, since an async process carries no timeout flag: a `SIGKILL` from outside before then is an exit. It waits for the output at most 1 s (`OUTPUT_GRACE_MS`) after the exit, then lets go of the pipes, which a killed shell's children may hold: neither the grace nor those children keep the calling process alive. Past the grace, stdout and stderr are both empty, even when one pipe had delivered its bytes. `runSync` reads Bun's own timeout flag, has no grace, and reports a process a signal ended with code 128 plus the signal's number, as `run` does. Both read text output as UTF-8 with a leading BOM dropped. Every process starts with `windowsHide`. |
| `git(args, options)`, `gitSync` | Runs git through `run`, its output raw, untrimmed, a failure an `exited` result. A git missing from the PATH throws. `cwd` is an option; a call that names its repository with `-C` keeps it in `args`. Options beyond `run`'s, all opt-in: `cLocale` sets `LC_ALL=C`; `scrubGitEnv` leaves out every `GIT_*` variable of this process's environment before `env` is laid over it, `GIT_CONFIG_GLOBAL` among them; `config` passes each `key=value` as `-c` before `args`. A call that removes some variables only, as `.claude/hooks/checkout.ts` removes what `git rev-parse --local-env-vars` lists, names each as `undefined` in `env`. |
| `gitRead(args, options)` | A git command that must succeed: its stdout trimmed at both ends. Any other end throws a `GitError` whose message is `git <args> failed (exit <code>): <stderr trimmed>`, or `git <args> timed out after <n> ms: <stderr trimmed>`. An output whose columns matter, as `status --porcelain` leads a line with a space, goes through `git`. |

## What the lint holds

Two rules, `local/no-raw-rename` and `local/no-raw-git-spawn` (`tools/oxlint/local/`), report a
`rename` from `node:fs` and a git spawned by hand outside this directory, its copies and the tests,
wherever `oxlint.config.ts` sets them to `error`. They are the only guarantee that code goes
through these helpers: no rule sees a hand-written shell quote, errno test, error message, path
check or in-place write, so those families use the helpers by review alone.
