import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Argv } from "./node.ts";
import { git, GitError, gitRead, gitReadSync, gitSync, run, runSync } from "./node.ts";

const BUN = process.execPath;

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
 * call left running, a timer or a pipe read, holds its event loop.
 */
async function lingeringAfter(call: string): Promise<number> {
  const script = [
    `const { run } = await import(${NODE_TS});`,
    call,
    "const returned = performance.now();",
    `process.on("exit", () => process.stdout.write(String(Math.round(performance.now() - returned))));`,
  ].join("\n");

  const result = await run(bun(script));

  return result.kind === "exited" ? Number(result.stdout) : Number.NaN;
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
    },
  );

  test("a call that returned leaves nothing that keeps this process alive", async () => {
    const lingered = await lingeringAfter(`await run(${JSON.stringify(bun("1"))})`);

    expect(lingered).toBeLessThan(500);
  });

  test("the pipes a child's child holds are let go of once the grace period passes", async () => {
    const holder = JSON.stringify([BUN, "-e", "await Bun.sleep(4000)"]);

    const parent = bun(
      `Bun.spawn(${holder}, { stdout: "inherit", stderr: "inherit" }); await Bun.sleep(10000)`,
    );

    const lingered = await lingeringAfter(
      `await run(${JSON.stringify(parent)}, { timeoutMs: 500 })`,
    );

    expect(lingered).toBeLessThan(1000);
  });

  test("a timeout answers timedOut, with the output printed before the kill", async () => {
    const result = await run(bun(`process.stdout.write("early\\n"); await Bun.sleep(10000)`), {
      timeoutMs: 2000,
    });

    expect(result).toEqual({ kind: "timedOut", timeoutMs: 2000, stdout: "early\n", stderr: "" });
  });

  test("the pipes a killed parent's child holds are waited for the grace period, then left", async () => {
    const child = JSON.stringify([BUN, "-e", "await Bun.sleep(10000)"]);
    const started = Date.now();

    const result = await run(
      bun(`Bun.spawn(${child}, { stdout: "inherit", stderr: "inherit" }); await Bun.sleep(10000)`),
      { timeoutMs: 2000 },
    );

    expect(result).toEqual({ kind: "timedOut", timeoutMs: 2000, stdout: "", stderr: "" });
    expect(Date.now() - started).toBeLessThan(6000);
  });

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

  test("a cwd that does not exist throws", async () => {
    await expect(run(bun("1"), { cwd: join(dir, "none") })).rejects.toThrow();
  });

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
    expect(() => runSync(bun("1"), { cwd: join(dir, "none") })).toThrow();

    const bytes = runSync(bun("process.stdout.write(new Uint8Array([0, 255]))"), {
      stdout: "buffer",
    });

    expect(bytes.kind === "exited" ? [...bytes.stdout] : null).toEqual([0, 255]);
  });
});

/** A repository in `dir` holding one commit of `file`. */
function repo(): string {
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "t@example.com"],
    ["config", "user.name", "T"],
    ["config", "commit.gpgsign", "false"],
  ]) {
    gitReadSync(args, { cwd: dir });
  }

  writeFileSync(join(dir, "file"), new Uint8Array([0, 255, 10]));
  gitReadSync(["add", "file"], { cwd: dir });
  gitReadSync(["commit", "-q", "-m", "one"], { cwd: dir });

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

  test("a git missing from the PATH throws", async () => {
    await expect(git(["--version"], { env: { PATH: dir } })).rejects.toThrow(
      "git is not on the PATH",
    );
    expect(() => gitSync(["--version"], { env: { PATH: dir } })).toThrow("git is not on the PATH");
  });

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

  test("throw a GitError naming the command, the exit code and git's stderr", async () => {
    const cwd = repo();

    const failure: unknown = await gitRead(["rev-parse", "--verify", "nope"], { cwd }).catch(
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(GitError);
    expect(failure instanceof Error ? failure.message : "").toBe(
      "git rev-parse --verify nope failed (exit 128): fatal: Needed a single revision",
    );
    expect(() => gitReadSync(["rev-parse", "--verify", "nope"], { cwd })).toThrow(GitError);
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
