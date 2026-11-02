import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tryLock } from "../headless/flock.ts";
import type { Clock } from "./ci-wait.ts";
import {
  DIR_ENV,
  type Holder,
  lockPaths,
  pushRefusal,
  repositoryOf,
  withLandingLock,
} from "./landing-lock.ts";

const ORIGIN = "https://github.com/o/r.git";

const DEV_PUSH = `refs/heads/feature/x ${"a".repeat(40)} refs/heads/dev ${"b".repeat(40)}\n`;

let dir = "";

let saved: string | undefined;

let opened: number[] = [];

/** The lock file opened as another landing would, its descriptor closed after the test. */
function open(): number {
  const fd = openSync(lockPaths(ORIGIN).lock, "a");

  opened.push(fd);

  return fd;
}

/** The lock taken by another landing, whose holder file names `holder`. */
function heldBy(holder: Holder): number {
  const fd = open();

  expect(tryLock(fd, "exclusive")).toBe(true);
  writeFileSync(lockPaths(ORIGIN).holder, JSON.stringify(holder));

  return fd;
}

/** A clock that moves only when the lock's wait sleeps, `during` run at each sleep. */
function clockOf(during: (sleeps: number) => void = () => {}): Clock {
  let now = 0;
  let sleeps = 0;

  return {
    now: () => now,
    sleep: (ms) => {
      now += ms;
      sleeps += 1;
      during(sleeps);

      return Promise.resolve();
    },
  };
}

const OTHER: Holder = { pid: 4242, branch: "feature/other", since: "2026-11-02T10:00:00.000Z" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "landing-lock-"));
  saved = process.env[DIR_ENV];
  process.env[DIR_ENV] = dir;
  opened = [];
});

afterEach(() => {
  for (const fd of opened) closeSync(fd);

  if (saved === undefined) delete process.env[DIR_ENV];
  else process.env[DIR_ENV] = saved;

  rmSync(dir, { recursive: true, force: true });
});

describe("withLandingLock", () => {
  test("runs under the lock, its holder named while it runs, and releases it", async () => {
    const paths = lockPaths(ORIGIN);

    const result = await withLandingLock(
      ORIGIN,
      "feature/x",
      { clock: clockOf(), timeoutMs: 60_000 },
      () => {
        const holder: Holder = JSON.parse(readFileSync(paths.holder, "utf8"));

        expect(holder.pid).toBe(process.pid);
        expect(holder.branch).toBe("feature/x");
        expect(tryLock(open(), "exclusive")).toBe(false);

        return Promise.resolve("landed");
      },
    );

    expect(result).toBe("landed");
    expect(existsSync(paths.holder)).toBe(false);
    expect(tryLock(open(), "exclusive")).toBe(true);
  });

  test("waits for the landing that holds it, then runs", async () => {
    const other = heldBy(OTHER);
    let ranAt = -1;

    const clock = clockOf((sleeps) => {
      if (sleeps !== 2) return;

      closeSync(other);
      opened = opened.filter((fd) => fd !== other);
    });

    const result = await withLandingLock(ORIGIN, "feature/x", { clock, timeoutMs: 60_000 }, () => {
      ranAt = clock.now();

      return Promise.resolve("landed");
    });

    expect(result).toBe("landed");
    expect(ranAt).toBe(10_000);
  });

  test("refuses once the holder keeps it past the wait, naming it, and runs nothing", async () => {
    heldBy(OTHER);
    let ran = false;

    const result = await withLandingLock(
      ORIGIN,
      "feature/x",
      { clock: clockOf(), timeoutMs: 12_000 },
      () => {
        ran = true;

        return Promise.resolve("landed");
      },
    );

    expect(result).toEqual({
      kind: "refused",
      why: "dev is being landed by pid 4242 (feature/other) since 2026-11-02T10:00:00.000Z: land again",
    });
    expect(ran).toBe(false);
    expect(JSON.parse(readFileSync(lockPaths(ORIGIN).holder, "utf8"))).toEqual(OTHER);
  });

  test("releases the lock when what runs under it throws", async () => {
    const landing = withLandingLock(
      ORIGIN,
      "feature/x",
      { clock: clockOf(), timeoutMs: 60_000 },
      () => Promise.reject(new Error("the landing broke")),
    );

    await expect(landing).rejects.toThrow("the landing broke");
    expect(tryLock(open(), "exclusive")).toBe(true);
    expect(existsSync(lockPaths(ORIGIN).holder)).toBe(false);
  });

  test("shares the lock between clones that spell origin apart", async () => {
    heldBy(OTHER);

    const result = await withLandingLock(
      "git@github.com:o/r.git",
      "feature/x",
      { clock: clockOf(), timeoutMs: 0 },
      () => Promise.resolve("landed"),
    );

    expect(result).toEqual({ kind: "refused", why: expect.stringContaining("pid 4242") });
  });

  test("keys the lock on origin's URL: another repository's landing does not wait", async () => {
    heldBy(OTHER);

    const result = await withLandingLock(
      "https://github.com/o/other.git",
      "feature/x",
      { clock: clockOf(), timeoutMs: 0 },
      () => Promise.resolve("landed"),
    );

    expect(result).toBe("landed");
  });
});

describe("repositoryOf", () => {
  test("reads every spelling of one GitHub repository as one", () => {
    for (const url of [
      "git@github.com:Bengous/claude-code-plugins.git",
      "https://github.com/bengous/claude-code-plugins",
      "https://github.com/bengous/claude-code-plugins.git/",
      "ssh://git@github.com/bengous/claude-code-plugins.git",
    ]) {
      expect(repositoryOf(url)).toBe("github.com/bengous/claude-code-plugins");
    }
  });

  test("keeps a local path apart from another", () => {
    expect(repositoryOf("/tmp/land-a/origin.git")).toBe("/tmp/land-a/origin");
    expect(repositoryOf("/tmp/land-b/origin.git")).not.toBe(repositoryOf("/tmp/land-a/origin.git"));
  });
});

describe("pushRefusal", () => {
  test("lets a push through while no landing holds the lock", () => {
    expect(pushRefusal(DEV_PUSH, ORIGIN, undefined)).toBeNull();
  });

  test("refuses a push to dev while another process holds the lock, naming it", () => {
    heldBy(OTHER);

    expect(pushRefusal(DEV_PUSH, ORIGIN, undefined)).toBe(
      "a landing holds dev (pid 4242 (feature/other) since 2026-11-02T10:00:00.000Z): push to dev again once it ends",
    );
    expect(pushRefusal(DEV_PUSH, ORIGIN, "1")).not.toBeNull();
  });

  test("lets the holder's own push to dev through", () => {
    heldBy(OTHER);

    expect(pushRefusal(DEV_PUSH, ORIGIN, "4242")).toBeNull();
  });

  test("lets a push that moves no dev through while the lock is held", () => {
    heldBy(OTHER);

    const branchPush = `refs/heads/feature/x ${"a".repeat(40)} refs/heads/feature/x ${"b".repeat(40)}\n`;

    expect(pushRefusal(branchPush, ORIGIN, undefined)).toBeNull();
  });
});
