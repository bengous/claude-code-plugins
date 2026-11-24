import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { Clock, Gh } from "../releasing/ci-wait.ts";
import { REGISTRATION_MS } from "../releasing/ci-wait.ts";
import type { PullCheck, PullView } from "../releasing/release-pull.ts";
import { decide, exitOf, main, openThreadOf, report, requestOf } from "./pr-wait.ts";

const TIMEOUT_MS = 30 * 60_000;

const HEAD = "9dd89b0c5872e99e1dcd3bb10f7cf6c31ecf9713";

function check(name: string, verdict: PullCheck["verdict"], startedAt = "2026-01-01T10:00:00Z") {
  return { name, verdict, startedAt, url: `https://github.com/o/r/runs/${name}` };
}

function open(checks: readonly PullCheck[]): PullView {
  return {
    state: "OPEN",
    headRefOid: HEAD,
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    checks,
  };
}

interface ThreadFields {
  readonly isResolved?: boolean;
  readonly path?: string;
  readonly line?: number | null;
}

/** One review thread as the script's jq prints it. */
function threadNode({ isResolved = false, path = "a.ts", line = 5 }: ThreadFields): string {
  return JSON.stringify({
    isResolved,
    path,
    line,
    comments: { nodes: [{ body: "**Unproven change.**\nNo test fails." }] },
  });
}

interface FakeGh {
  readonly gh: Gh;
  readonly views: () => number;
  readonly calls: readonly (readonly string[])[];
}

const ELSEWHERE = () => ({ branch: "dev", head: "0000000000000000000000000000000000000000" });

/** A checkout of the fake pull request's branch, one commit past the head GitHub shows. */
const AHEAD = () => ({ branch: "feature/x", head: "7cb799e45872e99e1dcd3bb10f7cf6c31ecf9713" });

const FAILING_GH: Gh = () => Promise.reject(new Error("gh pr view 580 exited 1: HTTP 502"));

/** A `gh` whose pull request shows one more of `rollups` at each view, and one open thread. */
function fakeGh(rollups: readonly (readonly unknown[] | null)[]): FakeGh {
  let views = 0;
  const calls: (readonly string[])[] = [];

  const gh: Gh = (args) => {
    calls.push(args);

    if (args[0] === "api") {
      return Promise.resolve(
        `${threadNode({ isResolved: true, path: "done.ts" })}\n${threadNode({ path: "a.ts" })}\n`,
      );
    }

    if (args.includes("headRefName")) return Promise.resolve("feature/x\n");

    if (args.includes("labels")) return Promise.resolve("tier:human\nneeds-human\n");

    const statusCheckRollup = rollups[Math.min(views, rollups.length - 1)] ?? null;

    views += 1;

    return Promise.resolve(
      JSON.stringify({
        state: "OPEN",
        headRefOid: HEAD,
        mergeCommit: null,
        mergeable: "MERGEABLE",
        mergeStateStatus: "BLOCKED",
        statusCheckRollup,
      }),
    );
  };

  return { gh, views: () => views, calls };
}

function fakeClock(): Clock {
  let now = 0;

  return {
    now: () => now,
    sleep: (ms) => {
      now += ms;

      return Promise.resolve();
    },
  };
}

function run(name: string, status: string, conclusion: string | null) {
  return {
    __typename: "CheckRun",
    name,
    status,
    conclusion,
    detailsUrl: `https://github.com/o/r/runs/${name}`,
    startedAt: "2026-01-01T10:00:00Z",
  };
}

describe("decide", () => {
  test("both checks decided end the wait, whatever owner-gate says", () => {
    const checks = [check("owner-gate", "red"), check("test", "green"), check("review", "red")];

    expect(decide(open(checks), null, 0, TIMEOUT_MS)).toEqual({
      kind: "verdict",
      head: HEAD,
      checks: [check("test", "green"), check("review", "red")],
    });
  });

  test("a check is read at its latest run", () => {
    const checks = [
      check("test", "green"),
      check("review", "red", "2026-01-01T10:00:00Z"),
      check("review", "green", "2026-01-01T10:09:00Z"),
    ];

    expect(decide(open(checks), null, 0, TIMEOUT_MS)).toEqual({
      kind: "verdict",
      head: HEAD,
      checks: [check("test", "green"), check("review", "green", "2026-01-01T10:09:00Z")],
    });
  });

  test("a check older than one that still runs is the earlier run of a re-run, and is waited on", () => {
    const earlier = check("review", "green", "2026-01-01T10:00:00Z");
    const rerun = check("review (read)", "pending", "2026-01-01T10:30:00Z");

    expect(decide(open([check("test", "green"), earlier, rerun]), null, 0, TIMEOUT_MS)).toEqual({
      kind: "wait",
    });
    expect(
      decide(open([check("test", "green"), earlier, rerun]), null, TIMEOUT_MS, TIMEOUT_MS),
    ).toEqual({
      kind: "timeout",
      head: HEAD,
      checks: [check("test", "green"), earlier],
      waiting: ["test", "review"],
    });

    const before = check("validate", "pending", "2026-01-01T09:00:00Z");
    const later = check("review", "red", "2026-01-01T10:00:00Z");

    expect(
      decide(
        open([check("test", "green", "2026-01-01T10:05:00Z"), later, before]),
        null,
        0,
        TIMEOUT_MS,
      ),
    ).toEqual({
      kind: "verdict",
      head: HEAD,
      checks: [check("test", "green", "2026-01-01T10:05:00Z"), later],
    });
  });

  test("a head with no check yet is waited on, then answered as none", () => {
    expect(decide(open([]), null, REGISTRATION_MS - 1, TIMEOUT_MS)).toEqual({ kind: "wait" });
    expect(decide(open([]), null, REGISTRATION_MS, TIMEOUT_MS)).toEqual({
      kind: "none",
      head: HEAD,
      checks: [],
      missing: ["test", "review"],
    });
  });

  test("a check not created yet is waited on while another check of the head runs", () => {
    const checks = [check("validate (scoped)", "pending"), check("review (read)", "pending")];

    expect(decide(open(checks), null, REGISTRATION_MS * 5, TIMEOUT_MS)).toEqual({ kind: "wait" });
  });

  test("a pending check is waited on until the timeout, which names what it waited for", () => {
    const checks = [check("test", "green"), check("review", "pending")];

    expect(decide(open(checks), null, TIMEOUT_MS - 1, TIMEOUT_MS)).toEqual({ kind: "wait" });
    expect(decide(open([check("review", "pending")]), null, TIMEOUT_MS, TIMEOUT_MS)).toEqual({
      kind: "timeout",
      head: HEAD,
      checks: [check("review", "pending")],
      waiting: ["test", "review"],
    });
  });

  test("another head than the checkout's is waited on, then named, its verdicts unread", () => {
    const checks = [check("test", "green"), check("review", "red")];
    const mine = "7cb799e45872e99e1dcd3bb10f7cf6c31ecf9713";

    expect(decide(open(checks), mine, REGISTRATION_MS - 1, TIMEOUT_MS)).toEqual({ kind: "wait" });
    expect(decide(open(checks), mine, REGISTRATION_MS, TIMEOUT_MS)).toEqual({
      kind: "other-head",
      head: HEAD,
      expected: mine,
    });
    expect(decide(open(checks), HEAD, 0, TIMEOUT_MS)).toEqual({
      kind: "verdict",
      head: HEAD,
      checks,
    });
  });

  test("a merged or a closed pull request ends the wait at once", () => {
    expect(
      decide({ state: "MERGED", mergeCommit: "04719f62aa", headRefOid: HEAD }, null, 0, TIMEOUT_MS),
    ).toEqual({ kind: "merged", commit: "04719f62aa" });
    expect(decide({ state: "CLOSED" }, null, 0, TIMEOUT_MS)).toEqual({ kind: "closed" });
  });
});

describe("exitOf", () => {
  test.each([
    [{ kind: "merged", commit: "a" } as const, 0],
    [{ kind: "closed" } as const, 1],
    [{ kind: "verdict", head: HEAD, checks: [check("test", "green")] } as const, 0],
    [
      {
        kind: "verdict",
        head: HEAD,
        checks: [check("test", "green"), check("review", "red")],
      } as const,
      1,
    ],
    [{ kind: "none", head: HEAD, checks: [], missing: ["review"] } as const, 3],
    [{ kind: "timeout", head: HEAD, checks: [], waiting: ["review"] } as const, 3],
    [{ kind: "other-head", head: HEAD, expected: "7cb799e4" } as const, 3],
  ])("%p exits %p", (wait, code) => {
    expect(exitOf(wait)).toBe(code);
  });
});

describe("report", () => {
  test("prints the verdicts, the labels and each open thread", () => {
    const wait = {
      kind: "verdict",
      head: HEAD,
      checks: [check("test", "green"), check("review", "red")],
    } as const;

    expect(report(580, wait, ["tier:human"], ["a.ts:5  Unproven change."])).toBe(
      [
        "#580 head 9dd89b0c",
        "test     green  https://github.com/o/r/runs/test",
        "review   red  https://github.com/o/r/runs/review",
        "labels   tier:human",
        "threads  1 open",
        "  a.ts:5  Unproven change.",
      ].join("\n"),
    );
  });

  test("says what the wait lacked when it ended with no verdict", () => {
    const none = { kind: "none", head: HEAD, checks: [], missing: ["test", "review"] } as const;

    expect(report(7, none, [], [])).toBe(
      [
        "#7 head 9dd89b0c",
        "no test and no review on this head, and no check of it runs",
        "labels   none",
        "threads  0 open",
      ].join("\n"),
    );
  });

  test("a wait that ends with no verdict still prints the check that has one", () => {
    const timeout = {
      kind: "timeout",
      head: HEAD,
      checks: [check("test", "red"), check("review", "pending")],
      waiting: ["review"],
    } as const;

    expect(report(7, timeout, [], []).split("\n").slice(1, 4)).toEqual([
      "test     red  https://github.com/o/r/runs/test",
      "review   pending  https://github.com/o/r/runs/review",
      "still waiting for review at the timeout",
    ]);
  });

  test("names the two heads when the checkout is at another commit", () => {
    const other = { kind: "other-head", head: HEAD, expected: "7cb799e45872e99e" } as const;

    expect(report(7, other, [], []).split("\n").slice(0, 2)).toEqual([
      "#7 head 9dd89b0c",
      "this checkout is at 7cb799e4: push it, or pull the branch",
    ]);
  });
});

describe("openThreadOf", () => {
  test("prints an open thread as its path, its line and the first line of its first comment", () => {
    expect(openThreadOf(threadNode({}))).toBe("a.ts:5  **Unproven change.**");
  });

  test("leaves a resolved thread out, and prints 0 for the line an outdated thread lacks", () => {
    expect(openThreadOf(threadNode({ isResolved: true }))).toBeNull();
    expect(openThreadOf(threadNode({ line: null }))).toBe("a.ts:0  **Unproven change.**");
  });

  test("refuses a line that is no thread", () => {
    expect(() => openThreadOf('"a.ts"')).toThrow("gh gave a review thread that is no object");
  });
});

describe("requestOf", () => {
  test("reads the number and the timeout, thirty minutes by default", () => {
    expect(requestOf(["580"])).toEqual({ number: 580, timeoutMs: 30 * 60_000 });
    expect(requestOf(["580", "--timeout", "5"])).toEqual({ number: 580, timeoutMs: 5 * 60_000 });
  });

  test.each([
    [[]],
    [["#580"]],
    [["580", "--timeout"]],
    [["580", "--timeout", "0"]],
    [["580", "5"]],
  ])("asks nothing for %p", (argv) => {
    expect(requestOf(argv)).toBeNull();
  });
});

describe("main", () => {
  let out: string[] = [];
  let err: string[] = [];

  beforeEach(() => {
    out = [];
    err = [];
    spyOn(console, "log").mockImplementation((line: string) => out.push(line));
    spyOn(console, "error").mockImplementation((line: string) => err.push(line));
  });

  afterEach(() => {
    expect(err).toEqual([]);
  });

  test("polls a head with no check, then its pending checks, to the verdict", async () => {
    const { gh, views } = fakeGh([
      null,
      [run("review (read)", "IN_PROGRESS", null)],
      [run("test", "COMPLETED", "SUCCESS"), run("review", "IN_PROGRESS", null)],
      [run("test", "COMPLETED", "SUCCESS"), run("review", "COMPLETED", "FAILURE")],
    ]);

    expect(await main(["580"], gh, fakeClock(), ELSEWHERE)).toBe(1);
    expect(views()).toBe(4);
    expect(out.join("\n")).toBe(
      [
        "#580 head 9dd89b0c",
        "test     green  https://github.com/o/r/runs/test",
        "review   red  https://github.com/o/r/runs/review",
        "labels   tier:human, needs-human",
        "threads  1 open",
        "  a.ts:5  **Unproven change.**",
      ].join("\n"),
    );
  });

  test("gives up on a head whose checks never come, without waiting for the timeout", async () => {
    const { gh, views } = fakeGh([null]);

    expect(await main(["580"], gh, fakeClock(), ELSEWHERE)).toBe(3);
    expect(views()).toBe(5);
    expect(out[0]).toContain("no test and no review on this head");
  });

  test("a head with no check running on one poll alone is not given up on", async () => {
    const { gh } = fakeGh([
      [run("validate", "IN_PROGRESS", null)],
      [run("validate", "IN_PROGRESS", null)],
      [run("validate", "IN_PROGRESS", null)],
      [run("validate", "IN_PROGRESS", null)],
      [run("validate", "COMPLETED", "SUCCESS"), run("review", "COMPLETED", "SUCCESS")],
      [
        run("validate", "COMPLETED", "SUCCESS"),
        run("review", "COMPLETED", "SUCCESS"),
        run("test", "COMPLETED", "SUCCESS"),
      ],
    ]);

    expect(await main(["580"], gh, fakeClock(), ELSEWHERE)).toBe(0);
  });

  test("from a checkout of the branch, waits for the checkout's commit and no other", async () => {
    const { gh } = fakeGh([
      [run("test", "COMPLETED", "SUCCESS"), run("review", "COMPLETED", "FAILURE")],
    ]);

    expect(await main(["580"], gh, fakeClock(), AHEAD)).toBe(3);
    expect(out[0]).toContain("this checkout is at 7cb799e4: push it, or pull the branch");
    expect(await main(["580"], gh, fakeClock(), () => ({ branch: "feature/x", head: HEAD }))).toBe(
      1,
    );
  });

  test("reads every page of the review threads", async () => {
    const { gh, calls } = fakeGh([
      [run("test", "COMPLETED", "SUCCESS"), run("review", "COMPLETED", "SUCCESS")],
    ]);

    expect(await main(["580"], gh, fakeClock(), ELSEWHERE)).toBe(0);

    const threads = calls.find((args) => args[0] === "api") ?? [];

    expect(threads).toContain("--paginate");
    expect(threads.join(" ")).toContain("reviewThreads(first: 100, after: $endCursor)");
  });
});

describe("no verdict", () => {
  test("a gh call that fails exits 3 with its error, never the code of a red check", async () => {
    const err: string[] = [];

    spyOn(console, "error").mockImplementation((line: string) => err.push(line));

    expect(await main(["580"], FAILING_GH, fakeClock(), ELSEWHERE)).toBe(3);
    expect(err).toEqual(["pr-wait: no verdict: gh pr view 580 exited 1: HTTP 502"]);
  });

  test("a bad argument prints the usage and exits 2", async () => {
    const err: string[] = [];

    spyOn(console, "error").mockImplementation((line: string) => err.push(line));

    expect(await main(["latest"])).toBe(2);
    expect(err.join("\n")).toContain(
      "usage: pr-wait.ts <pull request number> [--timeout <minutes>]",
    );
  });
});
