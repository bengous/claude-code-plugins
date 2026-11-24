import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { Clock, Gh } from "../releasing/ci-wait.ts";
import { REGISTRATION_MS } from "../releasing/ci-wait.ts";
import type { PullCheck, PullView } from "../releasing/release-pull.ts";
import {
  decide,
  exitOf,
  main,
  openThreadOf,
  report,
  requestOf,
  rerunningOf,
  waitForVerdict,
} from "./pr-wait.ts";

const TIMEOUT_MS = 30 * 60_000;

const HEAD = "9dd89b0c5872e99e1dcd3bb10f7cf6c31ecf9713";

/** The workflow runs of the fixtures: CI is workflow 1, the review workflow 2, owner-gate 3. */
const CI_RUN = "100";

const REVIEW_RUN = "200";

function urlOf(name: string, workflowRun: string): string {
  return `https://github.com/o/r/actions/runs/${workflowRun}/job/${name.length}`;
}

/** Whether a `gh` call is the view of the pull request's checks. */
function isView(args: readonly string[]): boolean {
  return args.some((arg) => arg.includes("statusCheckRollup"));
}

function check(
  name: string,
  verdict: PullCheck["verdict"],
  startedAt = "2026-01-01T10:00:00Z",
  workflowRun = name === "test" ? CI_RUN : REVIEW_RUN,
) {
  return { name, verdict, startedAt, url: urlOf(name, workflowRun) };
}

function open(checks: readonly PullCheck[], mergeable = "MERGEABLE"): PullView {
  return { state: "OPEN", headRefOid: HEAD, mergeable, mergeStateStatus: "BLOCKED", checks };
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

function run(
  name: string,
  status: string,
  conclusion: string | null,
  startedAt = "2026-01-01T10:00:00Z",
  workflowRun = name === "test" ? CI_RUN : REVIEW_RUN,
) {
  return {
    __typename: "CheckRun",
    name,
    status,
    conclusion,
    detailsUrl: urlOf(name, workflowRun),
    startedAt,
  };
}

/** What GitHub shows of the fake pull request at one moment. */
interface Shown {
  /** `statusCheckRollup`, null for a head with no check. */
  readonly rollup: readonly unknown[] | null;
  /** The runs listing, one `id workflow status` per run; both workflows completed by default. */
  readonly runs?: readonly string[];
}

const COMPLETED = [`${CI_RUN}\t1\tcompleted`, `${REVIEW_RUN}\t2\tcompleted`];

/** What `gh` prints for one call on a pull request that shows `shown` and has one open thread. */
function printed(args: readonly string[], { rollup, runs = COMPLETED }: Shown): string {
  const endpoint = args.join(" ");

  if (endpoint.includes("graphql")) {
    return `${threadNode({ isResolved: true, path: "done.ts" })}\n${threadNode({})}\n`;
  }

  if (endpoint.includes("/actions/runs?head_sha=")) return `${runs.join("\n")}\n`;

  if (args.includes("headRefName")) return "feature/x\n";

  if (args.includes("labels")) return "tier:human\nneeds-human\n";

  return JSON.stringify({
    state: "OPEN",
    headRefOid: HEAD,
    mergeCommit: null,
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    statusCheckRollup: rollup,
  });
}

interface FakeGh {
  readonly gh: Gh;
  readonly views: () => number;
  readonly calls: readonly (readonly string[])[];
}

/** A `gh` whose pull request shows one more of `moments` at each view of it, then the last. */
function fakeGh(moments: readonly Shown[]): FakeGh {
  let views = 0;
  const calls: (readonly string[])[] = [];

  const gh: Gh = (args) => {
    calls.push(args);

    const view = isView(args);
    const shown = moments[Math.min(view ? views : views - 1, moments.length - 1)];

    if (view) views += 1;

    return Promise.resolve(printed(args, shown ?? { rollup: null }));
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

const ELSEWHERE = () => ({ branch: "dev", head: "0000000000000000000000000000000000000000" });

/** A checkout of the fake pull request's branch, one commit past the head GitHub shows. */
const AHEAD = () => ({ branch: "feature/x", head: "7cb799e45872e99e1dcd3bb10f7cf6c31ecf9713" });

const MINE = "7cb799e45872e99e1dcd3bb10f7cf6c31ecf9713";

describe("decide", () => {
  test("both checks decided end the wait, whatever owner-gate says", () => {
    const checks = [check("owner-gate", "red"), check("test", "green"), check("review", "red")];

    expect(decide(open(checks), null, [], 0, TIMEOUT_MS)).toEqual({
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

    expect(decide(open(checks), null, [], 0, TIMEOUT_MS)).toEqual({
      kind: "verdict",
      head: HEAD,
      checks: [check("test", "green"), check("review", "green", "2026-01-01T10:09:00Z")],
    });
  });

  test("a check whose workflow runs again is waited on, its earlier verdict unread", () => {
    const checks = [check("test", "green"), check("review", "red")];

    expect(decide(open(checks), null, ["review"], 0, TIMEOUT_MS)).toEqual({ kind: "wait" });
    expect(decide(open(checks), null, ["review"], TIMEOUT_MS, TIMEOUT_MS)).toEqual({
      kind: "timeout",
      head: HEAD,
      checks: [check("test", "green")],
      waiting: ["review"],
    });
  });

  test("a head with no check yet is waited on, then answered as none", () => {
    expect(decide(open([]), null, [], REGISTRATION_MS - 1, TIMEOUT_MS)).toEqual({ kind: "wait" });
    expect(decide(open([]), null, [], REGISTRATION_MS, TIMEOUT_MS)).toEqual({
      kind: "none",
      head: HEAD,
      checks: [],
      missing: ["test", "review"],
      conflict: false,
    });
  });

  test("a check not created yet is waited on while another check of the head runs", () => {
    const checks = [check("validate (scoped)", "pending"), check("review (read)", "pending")];

    expect(decide(open(checks), null, [], REGISTRATION_MS * 5, TIMEOUT_MS)).toEqual({
      kind: "wait",
    });
  });

  test("a pending check is waited on until the timeout, which names what it waited for", () => {
    const checks = [check("test", "green"), check("review", "pending")];

    expect(decide(open(checks), null, [], TIMEOUT_MS - 1, TIMEOUT_MS)).toEqual({ kind: "wait" });
    expect(decide(open(checks), null, [], TIMEOUT_MS, TIMEOUT_MS)).toEqual({
      kind: "timeout",
      head: HEAD,
      checks: [check("test", "green")],
      waiting: ["review"],
    });
  });

  test("another head than the checkout's is waited on, then named, its verdicts unread", () => {
    const checks = [check("test", "green"), check("review", "red")];

    expect(decide(open(checks), MINE, [], REGISTRATION_MS - 1, TIMEOUT_MS)).toEqual({
      kind: "wait",
    });
    expect(decide(open(checks), MINE, [], REGISTRATION_MS, TIMEOUT_MS)).toEqual({
      kind: "other-head",
      head: HEAD,
      expected: MINE,
    });
    expect(decide(open(checks), HEAD, [], 0, TIMEOUT_MS)).toEqual({
      kind: "verdict",
      head: HEAD,
      checks,
    });
  });

  test("a head with no check that conflicts with its base says so, after the same wait", () => {
    const conflicting = open([check("review", "red")], "CONFLICTING");

    expect(decide(conflicting, null, [], REGISTRATION_MS - 1, TIMEOUT_MS)).toEqual({
      kind: "wait",
    });
    expect(decide(conflicting, null, [], REGISTRATION_MS, TIMEOUT_MS)).toEqual({
      kind: "none",
      head: HEAD,
      checks: [check("review", "red")],
      missing: ["test"],
      conflict: true,
    });
  });

  test("a merged or a closed pull request ends the wait at once", () => {
    const merged = { state: "MERGED", mergeCommit: "04719f62aa", headRefOid: HEAD } as const;

    expect(decide(merged, null, [], 0, TIMEOUT_MS)).toEqual({
      kind: "merged",
      commit: "04719f62aa",
    });
    expect(decide(merged, HEAD, [], 0, TIMEOUT_MS)).toEqual({
      kind: "merged",
      commit: "04719f62aa",
    });
    expect(decide({ state: "CLOSED" }, null, [], 0, TIMEOUT_MS)).toEqual({ kind: "closed" });
  });

  test("a pull request merged at another commit than the checkout's did not merge that commit", () => {
    const merged = { state: "MERGED", mergeCommit: "04719f62aa", headRefOid: HEAD } as const;

    expect(decide(merged, MINE, [], 0, TIMEOUT_MS)).toEqual({
      kind: "other-head",
      head: HEAD,
      expected: MINE,
    });
  });
});

describe("rerunningOf", () => {
  const checks = [check("test", "green"), check("review", "red")];
  const done = { id: REVIEW_RUN, workflow: "2", status: "completed" };
  const ci = { id: CI_RUN, workflow: "1", status: "completed" };

  test("names no check while every run of its workflow has completed", () => {
    expect(rerunningOf(checks, [ci, done])).toEqual([]);
  });

  test("names the check whose own run is in progress again, or whose workflow has a newer run", () => {
    expect(rerunningOf(checks, [ci, { ...done, status: "in_progress" }])).toEqual(["review"]);
    expect(rerunningOf(checks, [ci, done, { id: "201", workflow: "2", status: "queued" }])).toEqual(
      ["review"],
    );
  });

  test("leaves a check alone while another workflow runs, owner-gate's among them", () => {
    expect(
      rerunningOf(checks, [ci, done, { id: "300", workflow: "3", status: "in_progress" }]),
    ).toEqual([]);
  });

  test("leaves alone a check whose link names no workflow run, as a commit status", () => {
    const status = { ...check("review", "red"), url: "https://example.org/status" };

    expect(rerunningOf([status], [{ ...done, status: "in_progress" }])).toEqual([]);
  });

  test("refuses a listing that lacks the run a check's link names", () => {
    expect(() => rerunningOf(checks, [ci])).toThrow(
      `the runs of the head hold no run ${REVIEW_RUN}, review's`,
    );
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
    [{ kind: "none", head: HEAD, checks: [], missing: ["review"], conflict: false } as const, 3],
    [{ kind: "timeout", head: HEAD, checks: [], waiting: ["review"] } as const, 3],
    [{ kind: "other-head", head: HEAD, expected: "7cb799e4" } as const, 3],
    [{ kind: "failed", why: "HTTP 502", seen: null } as const, 3],
  ])("%p exits %p", (wait, code) => {
    expect(exitOf(wait)).toBe(code);
  });
});

describe("report", () => {
  const notes = { labels: ["tier:human"], threads: ["a.ts:5  Unproven change."] };
  const bare = { labels: [], threads: [] };

  test("prints the verdicts, the labels and each open thread", () => {
    const wait = {
      kind: "verdict",
      head: HEAD,
      checks: [check("test", "green"), check("review", "red")],
    } as const;

    expect(report(580, wait, notes)).toBe(
      [
        "#580 head 9dd89b0c",
        `test     green  ${urlOf("test", CI_RUN)}`,
        `review   red  ${urlOf("review", REVIEW_RUN)}`,
        "labels   tier:human",
        "threads  1 open",
        "  a.ts:5  Unproven change.",
      ].join("\n"),
    );
  });

  test("says what the wait lacked when it ended with no verdict", () => {
    const none = {
      kind: "none",
      head: HEAD,
      checks: [],
      missing: ["test", "review"],
      conflict: false,
    } as const;

    expect(report(7, none, bare)).toBe(
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
      checks: [check("test", "red")],
      waiting: ["review"],
    } as const;

    expect(report(7, timeout, bare).split("\n").slice(1, 3)).toEqual([
      `test     red  ${urlOf("test", CI_RUN)}`,
      "still waiting for review at the timeout",
    ]);
  });

  test("names the conflict of a head with no check, and the two heads of another checkout", () => {
    const other = { kind: "other-head", head: HEAD, expected: "7cb799e45872e99e" } as const;

    const none = {
      kind: "none",
      head: HEAD,
      checks: [],
      missing: ["test"],
      conflict: true,
    } as const;

    expect(report(7, none, bare).split("\n")[1]).toBe(
      "no test on this head: it conflicts with its base, where GitHub starts no check. Merge the base in",
    );
    expect(report(7, other, bare).split("\n")[1]).toBe(
      "this checkout is at 7cb799e4: push it, or pull the branch",
    );
  });

  test("a wait gh ended prints its error, under the verdicts it could not confirm", () => {
    const seen = { head: HEAD, checks: [check("review", "red")] };

    expect(report(7, { kind: "failed", why: "HTTP 502", seen: null }, bare).split("\n")[0]).toBe(
      "#7 no verdict: HTTP 502",
    );
    expect(
      report(7, { kind: "failed", why: "HTTP 502", seen }, bare).split("\n").slice(0, 3),
    ).toEqual([
      "#7 head 9dd89b0c",
      `review   red  ${urlOf("review", REVIEW_RUN)}`,
      "no verdict: these could not be confirmed: HTTP 502",
    ]);
  });

  test("keeps the verdict when the labels and the threads could not be read", () => {
    const wait = { kind: "verdict", head: HEAD, checks: [check("review", "red")] } as const;

    expect(report(7, wait, { unread: "HTTP 502" })).toBe(
      [
        "#7 head 9dd89b0c",
        `review   red  ${urlOf("review", REVIEW_RUN)}`,
        "labels and threads not read: HTTP 502",
      ].join("\n"),
    );
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
    [["580", "--timeout", "5", "more"]],
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

  const green = run("test", "COMPLETED", "SUCCESS");
  const red = run("review", "COMPLETED", "FAILURE");

  test("polls a head with no check, then its pending checks, to the verdict", async () => {
    const { gh, views, calls } = fakeGh([
      { rollup: null },
      { rollup: [run("review (read)", "IN_PROGRESS", null)] },
      { rollup: [green, run("review", "IN_PROGRESS", null)] },
      { rollup: [green, red] },
    ]);

    expect(await main(["580"], gh, fakeClock(), ELSEWHERE)).toBe(1);
    // Four polls, the last of which reads the pull request again once its runs show nothing running.
    expect(views()).toBe(5);
    // The runs are listed once both checks show a verdict, not at each poll before.
    expect(calls.filter((args) => args.join(" ").includes("/actions/runs?"))).toHaveLength(1);
    expect(out.join("\n")).toBe(
      [
        "#580 head 9dd89b0c",
        `test     green  ${urlOf("test", CI_RUN)}`,
        `review   red  ${urlOf("review", REVIEW_RUN)}`,
        "labels   tier:human, needs-human",
        "threads  1 open",
        "  a.ts:5  **Unproven change.**",
      ].join("\n"),
    );
  });

  test("gives up on a head whose checks never come, once two polls in a row read none", async () => {
    const { gh, views } = fakeGh([{ rollup: null }]);

    expect(await main(["580"], gh, fakeClock(), ELSEWHERE)).toBe(3);
    expect(views()).toBe(5);
    expect(out[0]).toContain("no test and no review on this head");
  });

  test("a head with no check running on one poll alone is not given up on", async () => {
    const validating = run("validate", "IN_PROGRESS", null);
    const validated = run("validate", "COMPLETED", "SUCCESS");
    const reviewed = run("review", "COMPLETED", "SUCCESS");

    const { gh } = fakeGh([
      { rollup: [validating] },
      { rollup: [validating] },
      { rollup: [validating] },
      { rollup: [validating] },
      { rollup: [validated, reviewed] },
      { rollup: [validated, reviewed, green] },
    ]);

    expect(await main(["580"], gh, fakeClock(), ELSEWHERE)).toBe(0);
  });

  test("a review run started again is waited for, through the moment none of its checks runs", async () => {
    const read = run("review (read)", "COMPLETED", "SUCCESS", "2026-01-01T10:30:00Z", "201");
    const again = [`${CI_RUN}\t1\tcompleted`, `${REVIEW_RUN}\t2\tcompleted`, "201\t2\tin_progress"];
    const over = [`${CI_RUN}\t1\tcompleted`, `${REVIEW_RUN}\t2\tcompleted`, "201\t2\tcompleted"];
    const passed = run("review", "COMPLETED", "SUCCESS", "2026-01-01T10:31:00Z", "201");

    const { gh, views } = fakeGh([
      { rollup: [green, red, read], runs: again },
      { rollup: [green, red, read], runs: again },
      { rollup: [green, red, read, passed], runs: over },
    ]);

    expect(await main(["580"], gh, fakeClock(), ELSEWHERE)).toBe(0);
    expect(views()).toBe(4);
    expect(out.join("\n")).toContain(`review   green  ${urlOf("review", "201")}`);
  });

  test("a verdict that changes between the view and the listing of the runs is not the answer", async () => {
    const passed = run("review", "COMPLETED", "SUCCESS", "2026-01-01T10:31:00Z");

    // The run started again ends right after the first view: the listing shows nothing running.
    const { gh, views } = fakeGh([{ rollup: [green, red] }, { rollup: [green, red, passed] }]);

    expect(await main(["580"], gh, fakeClock(), ELSEWHERE)).toBe(0);
    expect(views()).toBe(4);
    expect(out.join("\n")).toContain("review   green");
  });

  test("the wait ends at the timeout, whatever the interval between two polls", async () => {
    const { gh } = fakeGh([{ rollup: [green, run("review", "IN_PROGRESS", null)] }]);
    const clock = fakeClock();
    const wait = await waitForVerdict(gh, 580, null, { timeoutMs: 60_000, pollMs: 45_000 }, clock);

    expect(wait.kind).toBe("timeout");
    expect(clock.now()).toBe(60_000);
  });

  test("at the timeout, a check whose workflow still runs again is named, not answered", async () => {
    const again = [`${CI_RUN}\t1\tcompleted`, `${REVIEW_RUN}\t2\tin_progress`];
    const { gh } = fakeGh([{ rollup: [green, red], runs: again }]);

    expect(await main(["580", "--timeout", "1"], gh, fakeClock(), ELSEWHERE)).toBe(3);
    expect(out.join("\n")).toContain(
      [`test     green  ${urlOf("test", CI_RUN)}`, "still waiting for review at the timeout"].join(
        "\n",
      ),
    );
  });

  test("from a checkout of the branch, waits for the checkout's commit and no other", async () => {
    const { gh } = fakeGh([{ rollup: [green, red] }]);

    expect(await main(["580"], gh, fakeClock(), AHEAD)).toBe(3);
    expect(out[0]).toContain("this checkout is at 7cb799e4: push it, or pull the branch");
    expect(await main(["580"], gh, fakeClock(), () => ({ branch: "feature/x", head: HEAD }))).toBe(
      1,
    );
  });

  test("reads every page of the runs and of the review threads", async () => {
    const { gh, calls } = fakeGh([{ rollup: [green, run("review", "COMPLETED", "SUCCESS")] }]);

    expect(await main(["580"], gh, fakeClock(), ELSEWHERE)).toBe(0);

    const threads = calls.find((args) => args.includes("graphql")) ?? [];
    const runs = calls.find((args) => args.join(" ").includes("/actions/runs?")) ?? [];

    expect(threads).toContain("--paginate");
    expect(threads.join(" ")).toContain("reviewThreads(first: 100, after: $endCursor)");
    expect(runs).toContain("--paginate");
    expect(runs.join(" ")).toContain(`/actions/runs?head_sha=${HEAD}&per_page=100`);
  });
});

describe("a gh call that fails", () => {
  let out: string[] = [];
  let err: string[] = [];

  beforeEach(() => {
    out = [];
    err = [];
    spyOn(console, "log").mockImplementation((line: string) => out.push(line));
    spyOn(console, "error").mockImplementation((line: string) => err.push(line));
  });

  const decided = {
    rollup: [run("test", "COMPLETED", "SUCCESS"), run("review", "COMPLETED", "FAILURE")],
  };

  const pending = { rollup: [run("review", "IN_PROGRESS", null)] };

  /**
   * A `gh` that fails each call `fails` answers true for, and for the others prints one more of
   * `moments` at each view, then the last.
   */
  const failing = (
    fails: (args: readonly string[], view: number) => boolean,
    moments: readonly Shown[] = [decided],
  ): Gh => {
    let views = 0;

    return (args) => {
      if (isView(args)) views += 1;

      return fails(args, views)
        ? Promise.reject(new Error("gh exited 1: HTTP 502"))
        : Promise.resolve(printed(args, moments[Math.min(views, moments.length) - 1] ?? decided));
    };
  };

  test("one failed poll is polled again, and the verdict is read", async () => {
    const gh = failing((args, view) => isView(args) && view === 1);

    expect(await main(["580"], gh, fakeClock(), ELSEWHERE)).toBe(1);
    expect(out.join("\n")).toContain("review   red");
  });

  test("failed polls that are not in a row do not add up", async () => {
    const gh = failing(
      (args, view) => isView(args) && view % 2 === 1 && view < 7,
      [pending, pending, pending, pending, pending, pending, decided],
    );

    expect(await main(["580"], gh, fakeClock(), ELSEWHERE)).toBe(1);
    expect(out.join("\n")).toContain("review   red");
  });

  test("three failed polls in a row end the wait with exit 3, never the code of a red check", async () => {
    const gh = failing((args) => isView(args));

    expect(await main(["580"], gh, fakeClock(), ELSEWHERE)).toBe(3);
    expect(out[0]).toContain("#580 no verdict: gh exited 1: HTTP 502");
  });

  test("a runs listing that is no id, workflow and status is a failed poll", async () => {
    const few = failing(() => false, [{ ...decided, runs: ["100\tcompleted"] }]);
    const many = failing(() => false, [{ ...decided, runs: ["100\t1\tcompleted\tmore"] }]);

    expect(await main(["580"], few, fakeClock(), ELSEWHERE)).toBe(3);
    expect(await main(["580"], many, fakeClock(), ELSEWHERE)).toBe(3);
    expect(out.join("\n")).toContain(
      "gh gave a workflow run that is no id, workflow and status: 100\tcompleted",
    );
    expect(out.join("\n")).toContain(
      "gh gave a workflow run that is no id, workflow and status: 100\t1\tcompleted\tmore",
    );
  });

  test("verdicts the runs listing could not confirm are printed as unconfirmed, and exit 3", async () => {
    const gh = failing((args) => args.join(" ").includes("/actions/runs?"));

    expect(await main(["580"], gh, fakeClock(), ELSEWHERE)).toBe(3);
    expect(out.join("\n").split("\n").slice(0, 4)).toEqual([
      "#580 head 9dd89b0c",
      `test     green  ${urlOf("test", CI_RUN)}`,
      `review   red  ${urlOf("review", REVIEW_RUN)}`,
      "no verdict: these could not be confirmed: gh exited 1: HTTP 502",
    ]);
  });

  test("a failed poll between two polls that read no check starts the count of two again", async () => {
    const clock = fakeClock();
    const gh = failing((args, view) => isView(args) && view === 5, [{ rollup: null }]);

    expect(await main(["580"], gh, clock, ELSEWHERE)).toBe(3);
    expect(out[0]).toContain("no test and no review on this head");
    expect(clock.now()).toBe(120_000);
  });

  test("a verdict that was read is printed and decides the exit, whatever the threads read does", async () => {
    const gh = failing((args) => args.includes("graphql"));

    expect(await main(["580"], gh, fakeClock(), ELSEWHERE)).toBe(1);
    expect(out.join("\n")).toBe(
      [
        "#580 head 9dd89b0c",
        `test     green  ${urlOf("test", CI_RUN)}`,
        `review   red  ${urlOf("review", REVIEW_RUN)}`,
        "labels and threads not read: gh exited 1: HTTP 502",
      ].join("\n"),
    );
  });

  test("a failure to read the pull request's branch exits 3 before any wait", async () => {
    const gh = failing((args) => args.includes("headRefName"));

    expect(await main(["580"], gh, fakeClock(), ELSEWHERE)).toBe(3);
    expect(err).toEqual(["pr-wait: no verdict: gh exited 1: HTTP 502"]);
  });

  test("a bad argument prints the usage and exits 2", async () => {
    expect(await main(["latest"])).toBe(2);
    expect(err.join("\n")).toContain(
      "usage: pr-wait.ts <pull request number> [--timeout <minutes>]",
    );
  });
});
