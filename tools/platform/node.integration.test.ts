import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Argv } from "./node.ts";
import {
  git,
  GitError,
  GitMissingError,
  gitRead,
  gitReadSync,
  gitSync,
  LaunchError,
  run,
  runSync,
} from "./node.ts";
import { errnoOf, messageOf } from "./pure.ts";

const BUN = process.execPath;

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

const NODE_TS = JSON.stringify(pathToFileURL(join(import.meta.dir, "node.ts")).href);

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
  dir = mkdtempSync(join(tmpdir(), "platform-run-"));
});

afterEach(() => {
  delete process.env["PLATFORM_TEST_X"];
  rmSync(dir, { recursive: true, force: true });
});

function bun(script: string): Argv {
  return [BUN, "-e", script];
}

/**
 * How long, in ms, a bun process that imports `run` stays alive once `call` returned: what the
 * call left running, a timer or a pipe read, holds its event loop. A call that throws fails here.
 */
async function lingeringAfter(call: string): Promise<number> {
  const script = [
    `const { run } = await import(${NODE_TS});`,
    call,
    "const returned = performance.now();",
    `process.on("exit", () => process.stdout.write(String(Math.round(performance.now() - returned))));`,
  ].join("\n");

  const result = await run(bun(script));

  if (result.kind !== "exited" || result.code !== 0 || !/^\d+$/u.test(result.stdout))
    throw new Error(`the probe reported no time: ${JSON.stringify(result)}`);

  return Number(result.stdout);
}

describe("run", () => {
  test("captures stdout, stderr and the exit code", async () => {
    const result = await run(
      bun(`process.stdout.write("out\\n"); process.stderr.write("err\\n"); process.exit(3)`),
    );

    expect(result).toEqual({ kind: "exited", code: 3, stdout: "out\n", stderr: "err\n" });
  });

  test("runs in cwd", async () => {
    const result = await run(bun("process.stdout.write(process.cwd())"), { cwd: dir });

    expect(result).toMatchObject({
      kind: "exited",
      stdout: expect.stringMatching(/platform-run-\w+$/u),
    });
  });

  test("feeds stdin, as text or bytes", async () => {
    const echo = bun("process.stdout.write(await Bun.stdin.text())");

    expect(await run(echo, { stdin: "hello\nworld" })).toMatchObject({ stdout: "hello\nworld" });
    expect(await run(echo, { stdin: new TextEncoder().encode("bytes") })).toMatchObject({
      stdout: "bytes",
    });
  });

  test("lays env over this process's environment", async () => {
    process.env["PLATFORM_TEST_X"] = "1";

    const print = bun(
      `process.stdout.write(process.env.PLATFORM_TEST_X + process.env.PLATFORM_TEST_Y)`,
    );

    expect(await run(print, { env: { PLATFORM_TEST_Y: "2" } })).toMatchObject({ stdout: "12" });
    expect(await run(print, { env: { PLATFORM_TEST_X: "3", PLATFORM_TEST_Y: "4" } })).toMatchObject(
      {
        stdout: "34",
      },
    );
  });

  test("an undefined in env removes the variable, and keeps the others", async () => {
    process.env["PLATFORM_TEST_X"] = "1";
    process.env["PLATFORM_TEST_Y"] = "2";

    const print = bun(
      `process.stdout.write(String(process.env.PLATFORM_TEST_X) + process.env.PLATFORM_TEST_Y)`,
    );

    try {
      expect(await run(print, { env: { PLATFORM_TEST_X: undefined } })).toMatchObject({
        stdout: "undefined2",
      });
      expect(runSync(print, { env: { PLATFORM_TEST_X: undefined } })).toMatchObject({
        stdout: "undefined2",
      });
    } finally {
      delete process.env["PLATFORM_TEST_Y"];
    }
  });

  test.if(process.platform === "win32")(
    "on Windows, env replaces a variable spelled in another case",
    async () => {
      process.env["PLATFORM_TEST_X"] = "1";

      const print = bun(
        `process.stdout.write(JSON.stringify(Object.entries(process.env).filter(([name]) => name.toUpperCase() === "PLATFORM_TEST_X")))`,
      );

      const result = await run(print, { env: { platform_test_x: "2" } });

      expect(result.kind === "exited" ? JSON.parse(result.stdout) : null).toEqual([
        ["platform_test_x", "2"],
      ]);

      const twice = await run(print, { env: { platform_test_x: "2", PLATFORM_TEST_X: "3" } });

      expect(twice.kind === "exited" ? JSON.parse(twice.stdout) : null).toEqual([
        ["PLATFORM_TEST_X", "3"],
      ]);
    },
  );

  test("a call that returned leaves nothing that keeps this process alive", async () => {
    const lingered = await lingeringAfter(`await run(${JSON.stringify(bun("1"))})`);

    expect(lingered).toBeLessThan(500);
  });

  test("the pipes a child's child holds are let go of once the grace period passes", async () => {
    const holder = JSON.stringify([BUN, "-e", "await Bun.sleep(6000)"]);
    const spawned = join(dir, "holder-spawned");

    // The parent's output is dropped past the grace, so the holder's start is told by a file.
    const parent = bun(
      `Bun.spawn(${holder}, { stdout: "inherit", stderr: "inherit" }); await Bun.write(${JSON.stringify(spawned)}, "1"); await Bun.sleep(10000)`,
    );

    const lingered = await lingeringAfter(
      `await run(${JSON.stringify(parent)}, { timeoutMs: 2000 })`,
    );

    expect(existsSync(spawned)).toBe(true);
    expect(lingered).toBeLessThan(1000);
  });

  test.if(process.platform !== "win32")(
    "a SIGKILL from outside before timeoutMs is an exit, not a timeout",
    async () => {
      expect(
        await run(bun(`process.kill(process.pid, "SIGKILL")`), { timeoutMs: 10_000 }),
      ).toMatchObject({ kind: "exited", code: 137 });
    },
  );

  test("a leading BOM is dropped from text output, by run and runSync alike", async () => {
    const bom = bun("process.stdout.write(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))");

    expect(await run(bom)).toMatchObject({ kind: "exited", stdout: "hi" });
    expect(runSync(bom)).toMatchObject({ kind: "exited", stdout: "hi" });
  });

  test("a timeout answers timedOut, with the output printed before the kill", async () => {
    const result = await run(bun(`process.stdout.write("early\\n"); await Bun.sleep(10000)`), {
      timeoutMs: 2000,
    });

    expect(result).toEqual({ kind: "timedOut", timeoutMs: 2000, stdout: "early\n", stderr: "" });
  });

  // On Windows a child of the killed process does not keep its pipes: the read ends with the kill.
  test.if(process.platform !== "win32")(
    "the pipes a killed parent's child holds are waited for the grace period, then left",
    async () => {
      const child = JSON.stringify([BUN, "-e", "await Bun.sleep(10000)"]);
      const started = Date.now();

      const result = await run(
        bun(
          `Bun.spawn(${child}, { stdout: "inherit", stderr: "inherit" }); await Bun.sleep(10000)`,
        ),
        { timeoutMs: 2000 },
      );

      expect(result).toEqual({
        kind: "timedOut",
        timeoutMs: 2000,
        stdout: "",
        stderr: "",
        outputLost: true,
      });
      expect(Date.now() - started).toBeLessThan(6000);
    },
  );

  // On Windows the child's inherited pipes do not outlive the parent: nothing is lost.
  test.if(process.platform !== "win32")(
    "an exit whose child holds the pipes past the grace answers outputLost, its output empty",
    async () => {
      const holder = JSON.stringify([BUN, "-e", "await Bun.sleep(4000)"]);

      const result = await run(
        bun(
          `process.stdout.write("written"); Bun.spawn(${holder}, { stdout: "inherit", stderr: "inherit" }).unref()`,
        ),
      );

      expect(result).toEqual({ kind: "exited", code: 0, stdout: "", stderr: "", outputLost: true });
    },
  );

  test("timeoutMs <= 0 answers timedOut without starting anything", async () => {
    const results = await Promise.all(
      [0, -5].map((timeoutMs) => run(["no-such-binary-xyz"], { timeoutMs })),
    );

    expect(results).toEqual([
      { kind: "timedOut", timeoutMs: 0, stdout: "", stderr: "" },
      { kind: "timedOut", timeoutMs: -5, stdout: "", stderr: "" },
    ]);
  });

  test("a program not on the PATH is missing", async () => {
    expect(await run(["no-such-binary-xyz"])).toEqual({
      kind: "missing",
      program: "no-such-binary-xyz",
    });
  });

  test("a cwd that does not exist throws a LaunchError, Bun's message, error and errno kept", async () => {
    const thrown: unknown = await run(bun("1"), { cwd: join(dir, "none") }).catch(
      (cause: unknown) => cause,
    );

    const cause = thrown instanceof LaunchError ? thrown.cause : null;

    expect(thrown).toBeInstanceOf(LaunchError);
    expect(cause).toBeInstanceOf(Error);
    expect(messageOf(thrown)).toBe(messageOf(cause));
    expect(errnoOf(thrown)).toBe("ENOENT");
  });

  // Bun on Windows does not answer a path to no program with a LaunchError.
  test.if(process.platform !== "win32")(
    "a path to no program throws a LaunchError, by run and runSync alike",
    async () => {
      const nowhere = join(dir, "nowhere");

      const thrown = [
        await run([nowhere]).catch((cause: unknown) => cause),
        thrownBy(() => runSync([nowhere])),
      ];

      expect(thrown.map((cause) => cause instanceof LaunchError && errnoOf(cause))).toEqual([
        "ENOENT",
        "ENOENT",
      ]);
    },
  );

  test.if(process.platform !== "win32" && process.getuid?.() !== 0)(
    "a program it may not run throws a LaunchError whose errno is EACCES",
    async () => {
      const script = join(dir, "not-executable.sh");
      writeFileSync(script, "#!/bin/sh\n");
      chmodSync(script, 0o644);

      const thrown = [
        await run([script]).catch((cause: unknown) => cause),
        thrownBy(() => runSync([script])),
      ];

      expect(thrown.map((cause) => cause instanceof LaunchError && errnoOf(cause))).toEqual([
        "EACCES",
        "EACCES",
      ]);
    },
  );

  test("stdout: buffer answers the bytes as they came", async () => {
    const result = await run(bun("process.stdout.write(new Uint8Array([0, 255, 10]))"), {
      stdout: "buffer",
    });

    expect(result.kind === "exited" ? [...result.stdout] : null).toEqual([0, 255, 10]);
  });
});

describe("runSync", () => {
  test("captures stdout, stderr and the exit code, stdin fed", () => {
    const result = runSync(
      bun(
        `process.stdout.write(await Bun.stdin.text()); process.stderr.write("e"); process.exit(2)`,
      ),
      { stdin: "in" },
    );

    expect(result).toEqual({ kind: "exited", code: 2, stdout: "in", stderr: "e" });
  });

  test("a timeout answers timedOut", () => {
    expect(runSync(bun("await Bun.sleep(5000)"), { timeoutMs: 300 })).toEqual({
      kind: "timedOut",
      timeoutMs: 300,
      stdout: "",
      stderr: "",
    });
  });

  test.if(process.platform !== "win32")(
    "a SIGKILL from outside before timeoutMs is an exit, not a timeout",
    () => {
      expect(
        runSync(bun(`process.kill(process.pid, "SIGKILL")`), { timeoutMs: 10_000 }),
      ).toMatchObject({ kind: "exited", code: 137 });
    },
  );

  test.if(process.platform !== "win32")(
    "a process a signal ends exits with 128 plus the signal's number, as run answers it",
    async () => {
      const argv = bun(`process.kill(process.pid, "SIGTERM"); await Bun.sleep(5000)`);

      expect(runSync(argv)).toMatchObject({ kind: "exited", code: 143 });
      expect(await run(argv)).toMatchObject({ kind: "exited", code: 143 });
    },
  );

  test("missing, a missing cwd and stdout: buffer", () => {
    expect(runSync(["no-such-binary-xyz"])).toEqual({
      kind: "missing",
      program: "no-such-binary-xyz",
    });
    expect(() => runSync(bun("1"), { cwd: join(dir, "none") })).toThrow(LaunchError);

    const bytes = runSync(bun("process.stdout.write(new Uint8Array([0, 255]))"), {
      stdout: "buffer",
    });

    expect(bytes.kind === "exited" ? [...bytes.stdout] : null).toEqual([0, 255]);
  });
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

describe("races between processes", () => {
  test("withLock lets one holder at a time read, change and write a file", async () => {
    const counter = join(dir, "counter");
    writeFileSync(counter, "0");

    const script = `
      const { withLock } = await import(${NODE_TS});
      const { readFileSync, writeFileSync } = await import("node:fs");
      await withLock(${JSON.stringify(`${counter}.lock`)}, async () => {
        const seen = Number(readFileSync(${JSON.stringify(counter)}, "utf8"));
        await Bun.sleep(20);
        writeFileSync(${JSON.stringify(counter)}, String(seen + 1));
      }, { timeoutMs: 10000 });
    `;

    const results = await Promise.all(Array.from({ length: 8 }, () => run(bun(script))));

    expect(results.map((result) => result.kind === "exited" && result.code)).toEqual(
      Array.from({ length: 8 }, () => 0),
    );
    expect(readFileSync(counter, "utf8")).toBe("8");
    expect(readdirSync(dir)).toEqual(["counter"]);
  });

  test("createExclusiveSync lets exactly one of many creators win", async () => {
    const target = join(dir, "id.json");

    const script = `
      const { createExclusiveSync } = await import(${NODE_TS});
      await Bun.sleep(100);
      process.stdout.write(String(createExclusiveSync(${JSON.stringify(target)}, String(process.pid))));
    `;

    const results = await Promise.all(Array.from({ length: 8 }, () => run(bun(script))));
    const answers = results.map((result) => (result.kind === "exited" ? result.stdout : "none"));

    expect(answers.filter((answer) => answer === "true")).toHaveLength(1);
    expect(answers.filter((answer) => answer === "false")).toHaveLength(7);
    expect(readdirSync(dir)).toEqual(["id.json"]);
  });
});
