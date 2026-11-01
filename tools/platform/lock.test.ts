import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withLock } from "./lock.ts";
import { errnoOf } from "./pure.ts";

const WINDOWS = process.platform === "win32";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "platform-lock-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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
