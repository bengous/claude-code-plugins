import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Argv } from "./process.ts";
import { LaunchError, run, runSync } from "./process.ts";
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

const PROCESS_TS = JSON.stringify(pathToFileURL(join(import.meta.dir, "process.ts")).href);

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
    `const { run } = await import(${PROCESS_TS});`,
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
