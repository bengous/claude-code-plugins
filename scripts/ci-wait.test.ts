import { describe, expect, test } from "bun:test";

import {
  type CiRun,
  ciVerdict,
  type Clock,
  decide,
  type Gh,
  REGISTRATION_MS,
  waitFor,
} from "./ci-wait.ts";

const TIMEOUT_MS = 60 * 60_000;

function run(id: number, status: string, conclusion: string | null): CiRun {
  return { id, status, conclusion, url: `https://github.com/o/r/actions/runs/${id}` };
}

const green = (id: number) => run(id, "completed", "success");

describe("decide", () => {
  test("a run in progress is waited on", () => {
    expect(decide({ runs: [run(1, "in_progress", null)], elapsedMs: 5000 }, TIMEOUT_MS)).toEqual({
      kind: "wait",
    });
  });

  test("the label's run in progress is waited on, though the opening run is green", () => {
    const opening = green(1);
    const label = run(2, "queued", null);

    expect(decide({ runs: [opening, label], elapsedMs: 5000 }, TIMEOUT_MS)).toEqual({
      kind: "wait",
    });

    expect(decide({ runs: [opening, green(2)], elapsedMs: 9000 }, TIMEOUT_MS)).toEqual({
      kind: "green",
      runs: [opening, green(2)],
    });
  });

  test("runs that concluded are green, whatever their jobs still show (#361)", () => {
    // The REST listing of #361's head, its opening and label runs, while gh pr checks still showed
    // their skipped jobs in_progress.
    const runs = [green(39287017570), green(39287015338)];

    expect(decide({ runs, elapsedMs: 0 }, TIMEOUT_MS)).toEqual({ kind: "green", runs });
  });

  test("a failed run is red, its re-run waited on, and its green attempt green", () => {
    // Failed at attempt 1, green at attempt 3, which alone the listing of its head gives.
    const id = 39023707169;

    expect(decide({ runs: [run(id, "completed", "failure")], elapsedMs: 0 }, TIMEOUT_MS)).toEqual({
      kind: "red",
      red: [run(id, "completed", "failure")],
    });

    expect(decide({ runs: [run(id, "queued", null)], elapsedMs: 0 }, TIMEOUT_MS)).toEqual({
      kind: "wait",
    });

    expect(decide({ runs: [green(id)], elapsedMs: 0 }, TIMEOUT_MS)).toEqual({
      kind: "green",
      runs: [green(id)],
    });
  });

  test("a red run decides while another still runs", () => {
    const failed = run(1, "completed", "failure");

    expect(
      decide({ runs: [failed, run(2, "in_progress", null)], elapsedMs: 0 }, TIMEOUT_MS),
    ).toEqual({ kind: "red", red: [failed] });
  });

  test("a red run stays red beside a newer green run, a label added again", () => {
    const failed = run(1, "completed", "failure");

    expect(decide({ runs: [green(2), failed], elapsedMs: 0 }, TIMEOUT_MS)).toEqual({
      kind: "red",
      red: [failed],
    });
  });

  test("a run that ended other than success is red", () => {
    for (const conclusion of ["cancelled", "timed_out", "skipped", "startup_failure", "neutral"]) {
      expect(
        decide({ runs: [green(1), run(2, "completed", conclusion)], elapsedMs: 0 }, TIMEOUT_MS),
      ).toEqual({ kind: "red", red: [run(2, "completed", conclusion)] });
    }
  });

  test("no run is waited on while a run may still register, then is the verdict", () => {
    expect(decide({ runs: [], elapsedMs: 0 }, TIMEOUT_MS)).toEqual({ kind: "wait" });

    expect(decide({ runs: [], elapsedMs: REGISTRATION_MS - 1 }, TIMEOUT_MS)).toEqual({
      kind: "wait",
    });

    expect(decide({ runs: [], elapsedMs: REGISTRATION_MS }, TIMEOUT_MS)).toEqual({ kind: "none" });
  });

  test("no run is the verdict at a timeout shorter than the registration window", () => {
    expect(decide({ runs: [], elapsedMs: 10_000 }, 10_000)).toEqual({ kind: "none" });
  });

  test("a run still going at the timeout ends the wait, naming it", () => {
    const runs = [green(1), run(2, "in_progress", null)];

    expect(decide({ runs, elapsedMs: TIMEOUT_MS - 1 }, TIMEOUT_MS)).toEqual({ kind: "wait" });

    expect(decide({ runs, elapsedMs: TIMEOUT_MS }, TIMEOUT_MS)).toEqual({
      kind: "timeout",
      running: [run(2, "in_progress", null)],
    });
  });
});

/** gh's jq output: one compact object per run. */
const listing = (...runs: readonly CiRun[]): string =>
  runs.map((listed) => `${JSON.stringify(listed)}\n`).join("");

/** A gh that answers each call with the next of `outputs`, the last one again once they run out. */
function scripted(outputs: readonly string[]) {
  const calls: (readonly string[])[] = [];

  const gh: Gh = (args) => {
    calls.push(args);

    return Promise.resolve(outputs[Math.min(calls.length, outputs.length) - 1] ?? "");
  };

  return { gh, calls };
}

/** A clock that moves only when the wait sleeps, started far from zero as a real one is. */
function fakeClock() {
  let now = 1_000_000_000;
  const sleeps: number[] = [];

  const clock: Clock = {
    now: () => now,
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;

      return Promise.resolve();
    },
  };

  return { clock, sleeps };
}

describe("ciVerdict", () => {
  test("reads every ci.yml run of the commit and event from the REST listing", async () => {
    const { gh, calls } = scripted([listing(green(1), run(2, "in_progress", null))]);

    expect(await ciVerdict(gh, { sha: "abc", event: "pull_request" })).toEqual({
      kind: "running",
      running: [run(2, "in_progress", null)],
    });

    expect(calls).toEqual([
      [
        "api",
        "--paginate",
        "repos/{owner}/{repo}/actions/workflows/ci.yml/runs?head_sha=abc&event=pull_request&per_page=100",
        "--jq",
        ".workflow_runs[] | {id, status, conclusion, url: .html_url}",
      ],
    ]);
  });
});

describe("waitFor", () => {
  const push = { sha: "abc", event: "push" } as const;

  test("polls through registration and the run until it decides", async () => {
    const { gh, calls } = scripted(["", listing(run(7, "in_progress", null)), listing(green(7))]);
    const { clock, sleeps } = fakeClock();

    expect(await waitFor(gh, push, { timeoutMs: TIMEOUT_MS, pollMs: 10_000 }, clock)).toEqual({
      kind: "green",
      runs: [green(7)],
    });

    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([10_000, 10_000]);
  });

  test("ends on the timeout with the run still going", async () => {
    const { gh, calls } = scripted([listing(run(7, "in_progress", null))]);
    const { clock } = fakeClock();

    expect(await waitFor(gh, push, { timeoutMs: 30_000, pollMs: 10_000 }, clock)).toEqual({
      kind: "timeout",
      running: [run(7, "in_progress", null)],
    });

    expect(calls).toHaveLength(4);
  });

  test("ends on none once no run registered within the window", async () => {
    const { gh } = scripted([""]);
    const { clock, sleeps } = fakeClock();

    expect(await waitFor(gh, push, { timeoutMs: TIMEOUT_MS, pollMs: 5000 }, clock)).toEqual({
      kind: "none",
    });

    expect(sleeps).toHaveLength(REGISTRATION_MS / 5000);
  });
});
