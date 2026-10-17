import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { parse } from "yaml";

import { decide, type Gh, markerOf, type Observed, report } from "./red-dev.ts";

const RUN_A = { id: 1, url: "https://github.com/o/r/actions/runs/1", conclusion: "failure" };

const observed = (fields: Partial<Observed>): Observed => ({
  head: "aaa",
  run: RUN_A,
  failedJobs: ["validate"],
  issues: [],
  ...fields,
});

describe("decide", () => {
  test("a red head with no open issue opens one, its body marked with the head", () => {
    expect(decide(observed({ failedJobs: ["validate", "win32"] }))).toEqual({
      kind: "open",
      body: `CI's push run on \`dev\` failed at aaa: https://github.com/o/r/actions/runs/1\n\nRed jobs: \`validate\`, \`win32\`.\n\n${markerOf("aaa")}`,
    });
  });

  test("a red head comments on the newest open issue, once", () => {
    const issues = [
      { number: 12, texts: ["opened", markerOf("zzz")] },
      { number: 9, texts: ["older"] },
    ];

    expect(decide(observed({ issues }))).toMatchObject({ kind: "comment", issue: 12 });

    const reported = [{ number: 12, texts: ["opened", markerOf("aaa")] }];

    expect(decide(observed({ issues: reported })).kind).toBe("none");
  });

  test("a green head closes every open issue", () => {
    const green = { ...RUN_A, conclusion: "success" };

    const issues = [
      { number: 12, texts: [] },
      { number: 9, texts: [] },
    ];

    expect(decide(observed({ run: green, issues }))).toEqual({
      kind: "close",
      issues: [12, 9],
      comment: "CI's push run on `dev` is green at aaa: https://github.com/o/r/actions/runs/1",
    });
  });

  test("a head with no completed run, or one neither red nor green, changes nothing", () => {
    const issues = [{ number: 12, texts: [] }];

    expect(decide(observed({ run: null, issues })).kind).toBe("none");
    expect(decide(observed({ run: { ...RUN_A, conclusion: "cancelled" }, issues })).kind).toBe(
      "none",
    );
  });

  test("a run that timed out or could not start is red", () => {
    for (const conclusion of ["timed_out", "startup_failure"]) {
      expect(decide(observed({ run: { ...RUN_A, conclusion } })).kind).toBe("open");
    }
  });
});

interface Issue {
  number: number;
  open: boolean;
  body: string;
  comments: string[];
}

/** GitHub as red-dev sees it: dev's head, the CI push runs by commit, the issues. */
function world(head: string) {
  const issues: Issue[] = [];

  const state = {
    head,
    runs: new Map<string, { id: number; html_url: string; conclusion: string }>(),
    jobs: new Map<number, { name: string; conclusion: string }[]>(),
    issues,
  };

  const gh: Gh = (args) => {
    const [command, sub] = args;
    const path = sub ?? "";

    if (command === "api" && path === "repos/o/r/commits/dev") {
      return Promise.resolve(`${state.head}\n`);
    }

    const runs =
      /^repos\/o\/r\/actions\/workflows\/77\/runs\?head_sha=(\w+)&event=push&status=completed&per_page=1$/u.exec(
        path,
      );

    if (command === "api" && runs !== null) {
      const run = state.runs.get(runs[1] ?? "");

      return Promise.resolve(JSON.stringify(run === undefined ? [] : [run]));
    }

    const jobs = /^repos\/o\/r\/actions\/runs\/(\d+)\/jobs\?per_page=100$/u.exec(path);

    if (command === "api" && jobs !== null) {
      return Promise.resolve(JSON.stringify(state.jobs.get(Number(jobs[1])) ?? []));
    }

    if (command === "issue" && sub === "list") {
      const open = state.issues.filter((issue) => issue.open);

      return Promise.resolve(
        JSON.stringify(
          open.map(({ number, body, comments }) => ({
            number,
            body,
            comments: comments.map((text) => ({ body: text })),
          })),
        ),
      );
    }

    if (command === "issue" && sub === "create") {
      const body = args[args.indexOf("--body") + 1] ?? "";
      const number = state.issues.length + 1;
      state.issues.push({ number, open: true, body, comments: [] });

      return Promise.resolve(`https://github.com/o/r/issues/${number}\n`);
    }

    if (command === "issue" && (sub === "comment" || sub === "close")) {
      const issue = state.issues.find((found) => found.number === Number(args[2]));
      const flag = sub === "comment" ? "--body" : "--comment";
      issue?.comments.push(args[args.indexOf(flag) + 1] ?? "");

      if (sub === "close" && issue !== undefined) issue.open = false;

      return Promise.resolve("");
    }

    if (command === "label") return Promise.resolve("");

    return Promise.reject(new Error(`unexpected gh ${args.join(" ")}`));
  };

  const ran = (sha: string, id: number, conclusion: string, failed: string[] = []): void => {
    state.runs.set(sha, { id, html_url: `https://github.com/o/r/actions/runs/${id}`, conclusion });
    state.jobs.set(
      id,
      failed.map((name) => ({ name, conclusion: "failure" })),
    );
  };

  return { state, gh, ran };
}

const ENV = { GITHUB_REPOSITORY: "o/r", CI_WORKFLOW_ID: "77" };

const markersIn = (issue: Issue): string[] =>
  [issue.body, ...issue.comments].flatMap((text) => text.match(/<!-- red-dev:\w+ -->/gu) ?? []);

describe("report, against a GitHub that moves under it", () => {
  test("two red completions out of order: one issue, one report per commit", async () => {
    const { state, gh, ran } = world("aaa");
    ran("aaa", 1, "failure", ["validate"]);
    await report(ENV, gh);

    state.head = "bbb";
    ran("bbb", 2, "failure", ["mutation"]);
    // bbb's completion wakes red-dev, then aaa's, re-run, late.
    await report(ENV, gh);
    await report(ENV, gh);

    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]?.open).toBe(true);
    expect(state.issues.flatMap((issue) => markersIn(issue))).toEqual([
      markerOf("aaa"),
      markerOf("bbb"),
    ]);
    expect(state.issues[0]?.comments[0]).toContain("Red jobs: `mutation`.");
  });

  test("red then green out of order: the issue closes, and stays closed", async () => {
    const { state, gh, ran } = world("aaa");
    ran("aaa", 1, "failure", ["validate"]);
    await report(ENV, gh);

    state.head = "bbb";
    ran("bbb", 2, "success");
    await report(ENV, gh);
    // aaa's red completion, late.
    await report(ENV, gh);

    expect(state.issues.map((issue) => issue.open)).toEqual([false]);
    expect(state.issues[0]?.comments.at(-1)).toBe(
      "CI's push run on `dev` is green at bbb: https://github.com/o/r/actions/runs/2",
    );
  });

  test("a head CI has not completed changes nothing", async () => {
    const { state, gh, ran } = world("aaa");
    ran("aaa", 1, "failure", ["validate"]);
    await report(ENV, gh);

    state.head = "ccc";

    expect(await report(ENV, gh)).toBe("dev's head ccc has no completed CI push run yet");
    expect(state.issues.map((issue) => [issue.open, issue.comments.length])).toEqual([[true, 0]]);
  });

  test("refuses a run whose environment lacks a variable", async () => {
    const { gh } = world("aaa");

    await expect(report({ GITHUB_REPOSITORY: "o/r" }, gh)).rejects.toThrow(
      "CI_WORKFLOW_ID is unset",
    );
  });
});

interface Workflow {
  on?: { workflow_run?: { workflows?: string[]; types?: string[]; branches?: string[] } };
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs: Record<
    string,
    { permissions?: Record<string, string>; steps?: { env?: Record<string, string> }[] }
  >;
}

const workflowAt = async (path: string): Promise<Workflow> =>
  parse(await Bun.file(join(import.meta.dir, "..", path)).text());

test("red-dev.yml wakes on each CI run completed on dev, one run at a time", async () => {
  const workflow = await workflowAt(".github/workflows/red-dev.yml");

  expect(workflow.on).toEqual({
    workflow_run: { workflows: ["CI"], types: ["completed"], branches: ["dev"] },
  });
  expect(workflow.concurrency).toEqual({ group: "red-dev", "cancel-in-progress": false });
  expect(workflow.jobs["red-dev"]?.permissions).toEqual({
    actions: "read",
    contents: "read",
    issues: "write",
  });
});

test("ci.yml carries no red-dev job", async () => {
  expect(Object.keys((await workflowAt(".github/workflows/ci.yml")).jobs)).not.toContain("red-dev");
});
