import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { parse } from "yaml";

import { type Gh, parseNeeds, plan, report, verdictOf } from "./red-dev.ts";

const RUN = { sha: "abc123", url: "https://github.com/o/r/actions/runs/7" };

const results = (entries: Record<string, string>): ReadonlyMap<string, string> =>
  new Map(Object.entries(entries));

describe("parseNeeds", () => {
  test("reads each job's result off toJSON(needs)", () => {
    const json = JSON.stringify({
      validate: { result: "failure", outputs: {} },
      scope: { result: "skipped", outputs: { all: "" } },
    });

    expect([...parseNeeds(json)]).toEqual([
      ["validate", "failure"],
      ["scope", "skipped"],
    ]);
  });
});

describe("verdictOf", () => {
  test("red, naming each failed job, whatever the others say", () => {
    expect(
      verdictOf(results({ validate: "failure", win32: "cancelled", e2e: "skipped", w: "failure" })),
    ).toEqual({ kind: "red", jobs: ["validate", "w"] });
  });

  test("green when every job passed or was skipped", () => {
    expect(verdictOf(results({ validate: "success", e2e: "skipped" }))).toEqual({ kind: "green" });
  });

  test("unsettled when a job was cancelled and none failed", () => {
    expect(verdictOf(results({ validate: "success", win32: "cancelled" }))).toEqual({
      kind: "unsettled",
      jobs: ["win32 cancelled"],
    });
  });
});

describe("plan", () => {
  const red = { kind: "red", jobs: ["validate", "win32"] } as const;

  test("a red run with no open issue opens one, naming the run and the red jobs", () => {
    expect(plan(red, [], RUN)).toEqual({
      kind: "open",
      body: "CI's push run on `dev` failed at abc123: https://github.com/o/r/actions/runs/7\n\nRed jobs: `validate`, `win32`.",
    });
  });

  test("a red run comments on the newest open issue", () => {
    expect(plan(red, [12, 9], RUN)).toMatchObject({ kind: "comment", issue: 12 });
  });

  test("a green run closes every open issue", () => {
    expect(plan({ kind: "green" }, [12, 9], RUN)).toEqual({
      kind: "close",
      issues: [12, 9],
      comment: "CI's push run on `dev` is green at abc123: https://github.com/o/r/actions/runs/7",
    });
  });

  test("a green run with no open issue, or an unsettled one, does nothing", () => {
    expect(plan({ kind: "green" }, [], RUN).kind).toBe("none");
    expect(plan({ kind: "unsettled", jobs: ["win32 cancelled"] }, [12], RUN).kind).toBe("none");
  });
});

const env = (needs: Record<string, string>) => ({
  GITHUB_REPOSITORY: "o/r",
  GITHUB_SHA: "abc123",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_RUN_ID: "7",
  NEEDS: JSON.stringify(
    Object.fromEntries(Object.entries(needs).map(([job, result]) => [job, { result }])),
  ),
});

function fakeGh(head: string, open: number[]) {
  const calls: string[][] = [];

  const gh: Gh = (args) => {
    calls.push([...args]);

    if (args[0] === "api") return Promise.resolve(`${head}\n`);

    if (args[0] === "issue" && args[1] === "list") {
      return Promise.resolve(JSON.stringify(open.map((number) => ({ number }))));
    }

    if (args[0] === "issue" && args[1] === "create") {
      return Promise.resolve("https://github.com/o/r/issues/13\n");
    }

    return Promise.resolve("");
  };

  return { gh, calls };
}

describe("report", () => {
  test("a red run opens the issue under its label, which it creates or keeps", async () => {
    const { gh, calls } = fakeGh("abc123", []);

    expect(await report(env({ validate: "failure" }), gh)).toBe(
      "opened https://github.com/o/r/issues/13",
    );
    expect(calls.map((call) => call.slice(0, 2))).toEqual([
      ["api", "repos/o/r/commits/dev"],
      ["issue", "list"],
      ["label", "create"],
      ["issue", "create"],
    ]);
    expect(calls[3]).toContain("red-dev");
    expect(calls[3]?.join(" ")).toContain(
      "failed at abc123: https://github.com/o/r/actions/runs/7",
    );
  });

  test("a green run with no open issue says so and writes nothing", async () => {
    const { gh, calls } = fakeGh("abc123", []);

    expect(await report(env({ validate: "success" }), gh)).toBe(
      "dev is green at abc123, and no red-dev issue is open",
    );
    expect(calls).toHaveLength(2);
  });

  test("refuses a run whose environment lacks a variable, or holds it empty", async () => {
    const { gh } = fakeGh("abc123", []);
    const { GITHUB_SHA: _, ...noSha } = env({ validate: "success" });

    await expect(report(noSha, gh)).rejects.toThrow("GITHUB_SHA is unset");
    await expect(report({ ...noSha, GITHUB_SHA: "" }, gh)).rejects.toThrow("GITHUB_SHA is unset");
  });

  test("a red run comments on the newest open issue", async () => {
    const { gh, calls } = fakeGh("abc123", [9, 12]);

    expect(await report(env({ validate: "failure" }), gh)).toBe("commented on #12");
    expect(calls.at(-1)?.slice(0, 3)).toEqual(["issue", "comment", "12"]);
  });

  test("a green run closes each open issue", async () => {
    const { gh, calls } = fakeGh("abc123", [9, 12]);

    expect(await report(env({ validate: "success" }), gh)).toBe("closed #12, #9");
    expect(calls.slice(2).map((call) => call.slice(0, 3))).toEqual([
      ["issue", "close", "12"],
      ["issue", "close", "9"],
    ]);
  });

  test("a run on a commit dev has moved past touches no issue", async () => {
    const { gh, calls } = fakeGh("def456", [9]);

    expect(await report(env({ validate: "failure" }), gh)).toBe(
      "dev has moved past abc123 to def456: that push's run reports",
    );
    expect(calls).toHaveLength(1);
  });
});

interface Workflow {
  jobs: Record<string, { needs?: string[]; if?: string; permissions?: Record<string, string> }>;
}

test("ci.yml's red-dev job waits for every other job, on a push to dev alone", async () => {
  const source = await Bun.file(join(import.meta.dir, "../.github/workflows/ci.yml")).text();
  const { jobs }: Workflow = parse(source);
  const job = jobs["red-dev"];

  expect(job?.needs?.toSorted()).toEqual(
    Object.keys(jobs)
      .filter((name) => name !== "red-dev")
      .toSorted(),
  );
  expect(job?.if).toContain("github.ref == 'refs/heads/dev'");
  expect(job?.permissions).toEqual({ contents: "read", issues: "write" });
});
