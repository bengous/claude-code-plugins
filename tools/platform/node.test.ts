import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createExclusiveSync,
  GitError,
  isHeld,
  LaunchError,
  rename,
  renameSync,
  withLock,
  writeAtomic,
  writeAtomicSync,
} from "./node.ts";
import { errnoOf } from "./pure.ts";

const WINDOWS = process.platform === "win32";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "platform-node-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function coded(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** Holds a file of `folder` open, which on Windows refuses the folder's rename; answers the release. */
function holdFolder(folder: string): () => void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "held.txt"), "held");
  const fd = openSync(join(folder, "held.txt"), "r");

  return () => closeSync(fd);
}

describe("writeAtomic and writeAtomicSync", () => {
  test.each([
    ["async", (file: string, data: string | Uint8Array) => writeAtomic(file, data)],
    ["sync", (file: string, data: string | Uint8Array) => writeAtomicSync(file, data)],
  ] as const)("%s: replace the file whole and leave no scratch file", async (_, write) => {
    const file = join(dir, "state.json");
    writeFileSync(file, "old");

    await write(file, "new");
    await write(join(dir, "bytes.bin"), new Uint8Array([0, 255, 10]));

    expect(readFileSync(file, "utf8")).toBe("new");
    expect([...readFileSync(join(dir, "bytes.bin"))]).toEqual([0, 255, 10]);
    expect(readdirSync(dir).toSorted()).toEqual(["bytes.bin", "state.json"]);
  });

  test("mkdir creates the file's missing directories", async () => {
    await writeAtomic(join(dir, "a", "b", "x.txt"), "x", { mkdir: true });
    writeAtomicSync(join(dir, "c", "y.txt"), "y", { mkdir: true });

    expect(readFileSync(join(dir, "a", "b", "x.txt"), "utf8")).toBe("x");
    expect(readFileSync(join(dir, "c", "y.txt"), "utf8")).toBe("y");
  });

  test("without mkdir, a missing directory fails the write", async () => {
    expect(
      errnoOf(await writeAtomic(join(dir, "none", "x"), "x").catch((cause: unknown) => cause)),
    ).toBe("ENOENT");
    expect(() => writeAtomicSync(join(dir, "none", "x"), "x")).toThrow(/ENOENT/u);
  });

  test("a rename that fails removes the scratch file and leaves the target", async () => {
    const target = join(dir, "taken");
    mkdirSync(target);
    writeFileSync(join(target, "inside"), "kept");

    await expect(writeAtomic(target, "x")).rejects.toThrow();
    expect(() => writeAtomicSync(target, "x")).toThrow();
    expect(readdirSync(dir)).toEqual(["taken"]);
    expect(readFileSync(join(target, "inside"), "utf8")).toBe("kept");
  });
});

describe("rename and renameSync", () => {
  test("move a file", async () => {
    writeFileSync(join(dir, "a"), "a");
    await rename(join(dir, "a"), join(dir, "b"));
    renameSync(join(dir, "b"), join(dir, "c"));

    expect(readdirSync(dir)).toEqual(["c"]);
  });

  test("a missing source throws its errno at once", async () => {
    const started = Date.now();

    expect(
      errnoOf(
        await rename(join(dir, "none"), join(dir, "x"), { heldRetryMs: 2000 }).catch(
          (cause: unknown) => cause,
        ),
      ),
    ).toBe("ENOENT");
    expect(() => renameSync(join(dir, "none"), join(dir, "x"), { heldRetryMs: 2000 })).toThrow(
      /ENOENT/u,
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test.if(WINDOWS)(
    "a folder Windows holds is renamed again until it lets go, within heldRetryMs",
    async () => {
      const release = holdFolder(join(dir, "from"));
      setTimeout(release, 300);
      await rename(join(dir, "from"), join(dir, "to"), { heldRetryMs: 2000 });

      expect(existsSync(join(dir, "to", "held.txt"))).toBe(true);
    },
  );

  test.if(WINDOWS)("a folder held past heldRetryMs throws what isHeld names", async () => {
    const release = holdFolder(join(dir, "from"));
    const started = Date.now();

    const thrown = await rename(join(dir, "from"), join(dir, "to"), {
      heldRetryMs: 200,
    }).catch((cause: unknown) => cause);

    release();

    expect(isHeld(thrown)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });

  test.if(WINDOWS)("renameSync retries a held folder for heldRetryMs, then throws", () => {
    const release = holdFolder(join(dir, "from"));
    const started = Date.now();

    const thrown = (() => {
      try {
        renameSync(join(dir, "from"), join(dir, "to"), { heldRetryMs: 200 });

        return null;
      } catch (cause) {
        return cause;
      } finally {
        release();
      }
    })();

    expect(isHeld(thrown)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });
});

describe("isHeld", () => {
  test.if(!WINDOWS)("is false off Windows, where a held folder renames", () => {
    expect(isHeld(coded("EBUSY"))).toBe(false);
    expect(isHeld(coded("EPERM"))).toBe(false);
  });

  test.if(WINDOWS)("on Windows, EBUSY, EPERM and EACCES are held, nothing else", () => {
    expect(["EBUSY", "EPERM", "EACCES", "ENOENT"].map((code) => isHeld(coded(code)))).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  test("a value with no code is never held", () => {
    expect(isHeld(new Error("EBUSY"))).toBe(false);
    expect(isHeld("EBUSY")).toBe(false);
  });
});

describe("createExclusiveSync", () => {
  test("creates the file, true, and leaves no scratch file", () => {
    expect(createExclusiveSync(join(dir, "id.json"), "first")).toBe(true);
    expect(readFileSync(join(dir, "id.json"), "utf8")).toBe("first");
    expect(readdirSync(dir)).toEqual(["id.json"]);
  });

  test("false when the file exists, which keeps its content", () => {
    writeFileSync(join(dir, "id.json"), "first");

    expect(createExclusiveSync(join(dir, "id.json"), "second")).toBe(false);
    expect(readFileSync(join(dir, "id.json"), "utf8")).toBe("first");
    expect(readdirSync(dir)).toEqual(["id.json"]);
  });

  test("any other failure throws", () => {
    expect(() => createExclusiveSync(join(dir, "none", "id.json"), "x")).toThrow(/ENOENT/u);
  });
});

describe("withLock", () => {
  test("runs fn under the lock, then removes it", async () => {
    const lock = join(dir, "x.lock");

    const seen = await withLock(lock, () => Promise.resolve(readFileSync(lock, "utf8")), {
      timeoutMs: 1000,
    });

    expect(seen).toMatch(new RegExp(`^${process.pid} \\d{4}-\\d\\d-\\d\\dT\\S+Z\n$`, "u"));
    expect(existsSync(lock)).toBe(false);
  });

  test("removes the lock when fn throws, and rethrows", async () => {
    const lock = join(dir, "x.lock");

    await expect(
      withLock(lock, () => Promise.reject(new Error("fn failed")), { timeoutMs: 1000 }),
    ).rejects.toThrow("fn failed");
    expect(existsSync(lock)).toBe(false);
  });

  test("a second holder waits for the first to let go", async () => {
    const lock = join(dir, "x.lock");
    const order: string[] = [];
    const entered = Promise.withResolvers<void>();

    const slow = withLock(
      lock,
      async () => {
        order.push("first in");
        entered.resolve();
        await Bun.sleep(200);
        order.push("first out");
      },
      { timeoutMs: 1000 },
    );

    // Two creations started together race for the lock: the second asks once the first holds it.
    await entered.promise;

    const fast = withLock(
      lock,
      () => {
        order.push("second in");

        return Promise.resolve();
      },
      { timeoutMs: 2000 },
    );

    await Promise.all([slow, fast]);

    expect(order).toEqual(["first in", "first out", "second in"]);
  });

  test("a lock held past timeoutMs throws naming the file, the holder's pid and the age, and stays", async () => {
    const lock = join(dir, "x.lock");
    const since = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(lock, `4242 ${since}\n`);

    const failure: unknown = await withLock(lock, () => Promise.resolve("ran"), {
      timeoutMs: 150,
    }).catch((cause: unknown) => cause);

    const message = failure instanceof Error ? failure.message : "";

    expect(message.startsWith(`${lock} is still locked after 150 ms, by pid 4242 for 6`)).toBe(
      true,
    );
    expect(message).toMatch(/ for 6\d{4} ms; if no such process runs, remove the lock file$/u);
    expect(readFileSync(lock, "utf8")).toBe(`4242 ${since}\n`);
  });

  test.if(!WINDOWS)(
    "a lock that reads as gone at the deadline yet cannot be taken throws once tried again",
    async () => {
      const lock = join(dir, "x.lock");
      symlinkSync(join(dir, "nowhere"), lock);

      await expect(withLock(lock, () => Promise.resolve(), { timeoutMs: 50 })).rejects.toThrow(
        "by an unknown holder;",
      );
    },
  );

  test.if(!WINDOWS && process.getuid?.() !== 0)(
    "a lock its directory refuses to create fails at once with its errno, not as held",
    async () => {
      const locked = join(dir, "read-only");
      mkdirSync(locked);
      chmodSync(locked, 0o500);
      const started = performance.now();

      try {
        const thrown = await withLock(join(locked, "x.lock"), () => Promise.resolve(), {
          timeoutMs: 5000,
        }).catch((cause: unknown) => cause);

        expect(errnoOf(thrown)).toBe("EACCES");
        expect(performance.now() - started).toBeLessThan(1000);
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );

  test("a lock file it cannot read names an unknown holder", async () => {
    const lock = join(dir, "x.lock");
    writeFileSync(lock, "");

    await expect(withLock(lock, () => Promise.resolve(), { timeoutMs: 50 })).rejects.toThrow(
      "by an unknown holder;",
    );
  });
});

describe("GitError", () => {
  test("names the command, the exit code and the trimmed stderr", () => {
    const error = new GitError(["rev-parse", "nope"], {
      kind: "exited",
      code: 128,
      stdout: "",
      stderr: "fatal: bad revision\n",
    });

    expect(error.message).toBe("git rev-parse nope failed (exit 128): fatal: bad revision");
    expect(error.name).toBe("GitError");
  });

  test("names a timeout", () => {
    const error = new GitError(["fetch"], {
      kind: "timedOut",
      timeoutMs: 50,
      stdout: "",
      stderr: "",
    });

    expect(error.message).toBe("git fetch timed out after 50 ms: ");
  });

  test("names an output let go of after the grace, an exit 0 or a timeout", () => {
    const exited = new GitError(["commit-tree", "-S"], {
      kind: "exited",
      code: 0,
      stdout: "",
      stderr: "",
      outputLost: true,
    });

    const timedOut = new GitError(["fetch"], {
      kind: "timedOut",
      timeoutMs: 50,
      stdout: "",
      stderr: "",
      outputLost: true,
    });

    expect(exited.message).toBe("git commit-tree -S exited 0, its output let go of after 1000 ms");
    expect(timedOut.message).toBe(
      "git fetch timed out after 50 ms, its output let go of after 1000 ms",
    );
  });
});

describe("LaunchError", () => {
  test("keeps the message, the cause and the errno of the error it wraps", () => {
    const cause = Object.assign(new Error("EACCES: permission denied, posix_spawn '/x'"), {
      code: "EACCES",
    });

    const error = new LaunchError(cause);

    expect(error.message).toBe(cause.message);
    expect(error.cause).toBe(cause);
    expect(error.code).toBe("EACCES");
    expect(errnoOf(error)).toBe("EACCES");
    expect(error.name).toBe("LaunchError");
  });

  test("reads the errno off the message when the wrapped error has no code, as errnoOf does", () => {
    const error = new LaunchError(new Error("spawn failed: ENOENT"));

    expect(errnoOf(error)).toBe("ENOENT");
    expect(new LaunchError("not an error").message).toBe("not an error");
  });
});
