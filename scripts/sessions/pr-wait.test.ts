import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { Clock, Gh } from "../releasing/ci-wait.ts";
import { REGISTRATION_MS } from "../releasing/ci-wait.ts";
import type { PullCheck, PullView } from "../releasing/release-pull.ts";
import { decide, exitOf, main, report, requestOf } from "./pr-wait.ts";

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

interface FakeGh {
  readonly gh: Gh;
  readonly views: () => number;
}

/** A `gh` whose pull request shows one more of `rollups` at each view, and one open thread. */
function fakeGh(rollups: readonly (readonly unknown[] | null)[]): FakeGh {
  let views = 0;

  const gh: Gh = (args) => {
    if (args[0] === "api") return Promise.resolve("a.ts:5  Unproven change.\n");

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

  return { gh, views: () => views };
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

    expect(decide(open(checks), 0, TIMEOUT_MS)).toEqual({
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

    expect(decide(open(checks), 0, TIMEOUT_MS)).toEqual({
      kind: "verdict",
      head: HEAD,
      checks: [check("test", "green"), check("review", "green", "2026-01-01T10:09:00Z")],
    });
  });

  test("a head with no check yet is waited on, then answered as none", () => {
    expect(decide(open([]), REGISTRATION_MS - 1, TIMEOUT_MS)).toEqual({ kind: "wait" });
    expect(decide(open([]), REGISTRATION_MS, TIMEOUT_MS)).toEqual({
      kind: "none",
      head: HEAD,
      missing: ["test", "review"],
    });
  });

  test("a check not created yet is waited on while another check of the head runs", () => {
    const checks = [check("validate (scoped)", "pending"), check("review (read)", "pending")];

    expect(decide(open(checks), REGISTRATION_MS * 5, TIMEOUT_MS)).toEqual({ kind: "wait" });
  });

  test("a pending check is waited on until the timeout, which names what it waited for", () => {
    const checks = [check("test", "green"), check("review", "pending")];

    expect(decide(open(checks), TIMEOUT_MS - 1, TIMEOUT_MS)).toEqual({ kind: "wait" });
    expect(decide(open([check("review", "pending")]), TIMEOUT_MS, TIMEOUT_MS)).toEqual({
      kind: "timeout",
      head: HEAD,
      waiting: ["test", "review"],
    });
  });

  test("a merged or a closed pull request ends the wait at once", () => {
    expect(
      decide({ state: "MERGED", mergeCommit: "04719f62aa", headRefOid: HEAD }, 0, TIMEOUT_MS),
    ).toEqual({ kind: "merged", commit: "04719f62aa" });
    expect(decide({ state: "CLOSED" }, 0, TIMEOUT_MS)).toEqual({ kind: "closed" });
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
    [{ kind: "none", head: HEAD, missing: ["review"] } as const, 3],
    [{ kind: "timeout", head: HEAD, waiting: ["review"] } as const, 3],
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
    expect(report(7, { kind: "none", head: HEAD, missing: ["test", "review"] }, [], [])).toBe(
      [
        "#7 head 9dd89b0c",
        "no test and no review on this head, and no check of it runs",
        "labels   none",
        "threads  0 open",
      ].join("\n"),
    );
    expect(
      report(7, { kind: "timeout", head: HEAD, waiting: ["review"] }, [], []).split("\n")[1],
    ).toBe("still waiting for review at the timeout");
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

    expect(await main(["580"], gh, fakeClock())).toBe(1);
    expect(views()).toBe(4);
    expect(out.join("\n")).toBe(
      [
        "#580 head 9dd89b0c",
        "test     green  https://github.com/o/r/runs/test",
        "review   red  https://github.com/o/r/runs/review",
        "labels   tier:human, needs-human",
        "threads  1 open",
        "  a.ts:5  Unproven change.",
      ].join("\n"),
    );
  });

  test("gives up on a head whose checks never come, without waiting for the timeout", async () => {
    const { gh, views } = fakeGh([null]);

    expect(await main(["580"], gh, fakeClock())).toBe(3);
    expect(views()).toBe(4);
    expect(out[0]).toContain("no test and no review on this head");
  });
});

describe("usage", () => {
  test("a bad argument prints the usage and exits 2", async () => {
    const err: string[] = [];

    spyOn(console, "error").mockImplementation((line: string) => err.push(line));

    expect(await main(["latest"])).toBe(2);
    expect(err.join("\n")).toContain(
      "usage: pr-wait.ts <pull request number> [--timeout <minutes>]",
    );
  });
});
