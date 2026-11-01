import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { git, GitError, GitMissingError, gitRead, gitReadSync, gitSync } from "./git.ts";
import { LaunchError } from "./process.ts";
import { messageOf } from "./pure.ts";

/** What `call` throws, `null` when it returns; a thrown value that is no `Error` fails the test. */
function thrownBy(call: () => void): Error | null {
  try {
    call();

    return null;
  } catch (cause) {
    if (!(cause instanceof Error))
      throw new TypeError(`thrown, not an Error: ${String(cause)}`, { cause: cause });

    return cause;
  }
}

const KEPT_GIT_ENV = Object.entries(process.env).filter(([name]) => name.startsWith("GIT_"));

/** A pre-push hook or a linked worktree exports `GIT_DIR`, which would point every git here at the pushing repository. */
beforeAll(() => {
  for (const [name] of KEPT_GIT_ENV) delete process.env[name];
});

afterAll(() => {
  for (const [name, value] of KEPT_GIT_ENV) process.env[name] = value;
});

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "platform-git-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setUp(args: readonly string[]): void {
  const result = gitSync(args, { cwd: dir });

  if (result.kind !== "exited" || result.code !== 0) throw new GitError(args, result);
}

/** A repository in `dir` holding one commit of `file`. */
function repo(): string {
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "t@example.com"],
    ["config", "user.name", "T"],
    ["config", "commit.gpgsign", "false"],
  ]) {
    setUp(args);
  }

  writeFileSync(join(dir, "file"), new Uint8Array([0, 255, 10]));
  setUp(["add", "file"]);
  setUp(["commit", "-q", "-m", "one"]);

  return dir;
}

describe("git and gitSync", () => {
  test("answer the output raw, untrimmed", async () => {
    const cwd = repo();
    const result = await git(["log", "-1", "--format=%s"], { cwd });

    expect(result).toEqual({ kind: "exited", code: 0, stdout: "one\n", stderr: "" });
    expect(gitSync(["log", "-1", "--format=%s"], { cwd })).toEqual(result);
  });

  test("a failure is an exit, not a throw", async () => {
    const result = await git(["rev-parse", "--verify", "nope"], { cwd: repo() });

    expect(result).toMatchObject({ kind: "exited", code: 128 });
  });

  test("config passes -c entries, and cLocale sets LC_ALL=C", async () => {
    const result = await git(["printlocale"], {
      cwd: repo(),
      cLocale: true,
      config: ['alias.printlocale=!echo "[$LC_ALL]"'],
      env: { LC_ALL: "fr_FR.UTF-8" },
    });

    expect(result).toMatchObject({ kind: "exited", code: 0, stdout: "[C]\n" });
  });

  test("scrubGitEnv leaves out the GIT_* variables a hook exported", async () => {
    const cwd = repo();
    process.env["GIT_DIR"] = join(dir, "not-a-repository");

    try {
      expect(await git(["rev-parse", "--git-dir"], { cwd })).toMatchObject({ code: 128 });
      expect(await git(["rev-parse", "--git-dir"], { cwd, scrubGitEnv: true })).toEqual({
        kind: "exited",
        code: 0,
        stdout: ".git\n",
        stderr: "",
      });
    } finally {
      delete process.env["GIT_DIR"];
    }
  });

  test("an undefined in env removes one git variable and keeps the others", async () => {
    const cwd = repo();
    const config = join(dir, "isolated.gitconfig");
    writeFileSync(config, "[probe]\n\tkey = isolated\n");
    process.env["GIT_DIR"] = join(dir, "not-a-repository");
    process.env["GIT_CONFIG_GLOBAL"] = config;

    try {
      const result = await git(["config", "--global", "--get", "probe.key"], {
        cwd,
        env: { GIT_DIR: undefined },
      });

      expect(result).toEqual({ kind: "exited", code: 0, stdout: "isolated\n", stderr: "" });
      expect(gitSync(["rev-parse", "--git-dir"], { cwd, env: { GIT_DIR: undefined } })).toEqual({
        kind: "exited",
        code: 0,
        stdout: ".git\n",
        stderr: "",
      });
    } finally {
      delete process.env["GIT_DIR"];
      delete process.env["GIT_CONFIG_GLOBAL"];
    }
  });

  test("stdout: buffer answers a blob's bytes", async () => {
    const cwd = repo();
    const result = await git(["show", "HEAD:file"], { cwd, stdout: "buffer" });

    expect(result.kind === "exited" ? [...result.stdout] : null).toEqual([0, 255, 10]);
  });

  test("a git missing from the PATH throws a GitMissingError, by each of the four", async () => {
    const options = { env: { PATH: dir } };

    const thrown = [
      await git(["--version"], options).catch((cause: unknown) => cause),
      thrownBy(() => gitSync(["--version"], options)),
      await gitRead(["--version"], options).catch((cause: unknown) => cause),
      thrownBy(() => gitReadSync(["--version"], options)),
    ];

    expect(thrown.map((cause) => cause instanceof GitMissingError && messageOf(cause))).toEqual(
      Array.from({ length: 4 }, () => "git is not on the PATH"),
    );
  });

  test("a cwd that does not exist throws a LaunchError", async () => {
    const cwd = join(dir, "none");

    await expect(git(["--version"], { cwd })).rejects.toBeInstanceOf(LaunchError);
    expect(() => gitSync(["--version"], { cwd })).toThrow(LaunchError);
  });

  // The alias's line backgrounds a POSIX `sleep` that holds git's pipes once git exited.
  test.if(process.platform !== "win32")(
    "an exit 0 whose output the grace let go of: git flags it, gitRead throws",
    async () => {
      const options = { cwd: dir, config: ["alias.hold=!echo out; sleep 3 &"] };

      expect(await git(["hold"], options)).toEqual({
        kind: "exited",
        code: 0,
        stdout: "",
        stderr: "",
        outputLost: true,
      });

      const failure: unknown = await gitRead(["hold"], options).catch((cause: unknown) => cause);

      expect(failure).toBeInstanceOf(GitError);
      expect(messageOf(failure)).toBe("git hold exited 0, its output let go of after 1000 ms");
    },
  );

  test("timeoutMs answers timedOut", async () => {
    expect(await git(["--version"], { timeoutMs: 0 })).toMatchObject({ kind: "timedOut" });
  });
});

describe("gitRead and gitReadSync", () => {
  test("answer stdout trimmed", async () => {
    const cwd = repo();

    expect(await gitRead(["log", "-1", "--format=%s"], { cwd })).toBe("one");
    expect(gitReadSync(["log", "-1", "--format=%s"], { cwd })).toBe("one");
  });

  test("raw answers stdout as git wrote it, its leading column kept", async () => {
    const cwd = repo();
    writeFileSync(join(dir, "file"), "changed\n");

    expect(await gitRead(["status", "--porcelain"], { cwd, raw: true })).toBe(" M file\n");
    expect(gitReadSync(["status", "--porcelain"], { cwd, raw: true })).toBe(" M file\n");
  });

  test("throw a GitError naming the command, the exit code and git's stderr", async () => {
    const cwd = repo();

    const message =
      "git rev-parse --verify nope failed (exit 128): fatal: Needed a single revision";

    const failure: unknown = await gitRead(["rev-parse", "--verify", "nope"], { cwd }).catch(
      (cause: unknown) => cause,
    );

    const failureSync = thrownBy(() => gitReadSync(["rev-parse", "--verify", "nope"], { cwd }));

    expect(failure).toBeInstanceOf(GitError);
    expect(failureSync).toBeInstanceOf(GitError);
    expect([messageOf(failure), messageOf(failureSync)]).toEqual([message, message]);
  });

  test("pass git's options through: cwd, env, stdin, cLocale, scrubGitEnv and config", async () => {
    const cwd = repo();
    process.env["GIT_DIR"] = join(dir, "not-a-repository");

    const options = {
      cwd,
      env: { PLATFORM_TEST_X: "x" },
      stdin: "in",
      cLocale: true,
      scrubGitEnv: true,
      config: [
        'alias.probe=!printf "%s %s %s %s" "$LC_ALL" "$PLATFORM_TEST_X" "$(cat)" "$(git rev-parse --git-dir)"',
      ],
    };

    try {
      expect(await gitRead(["probe"], options)).toBe("C x in .git");
      expect(gitReadSync(["probe"], options)).toBe("C x in .git");
    } finally {
      delete process.env["GIT_DIR"];
    }
  });
});
