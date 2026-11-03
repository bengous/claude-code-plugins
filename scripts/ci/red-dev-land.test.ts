import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { parse } from "yaml";

import {
  admit,
  decide,
  type Gh,
  type Git,
  type GitResult,
  markerOf,
  type PullRequest,
  report,
  type Run,
  tierOf,
} from "./red-dev-land.ts";

const REPO = "o/r";

const SHA = "b4c89e32c29adb12598a20b4ec66e65bfa007eeb";

const RUN: Run = {
  event: "pull_request",
  conclusion: "success",
  headBranch: "fix/red-dev-489",
  headSha: SHA,
  headRepository: REPO,
};

const PR: PullRequest = {
  number: 490,
  headSha: SHA,
  base: "dev",
  crossRepository: false,
  texts: [],
};

describe("admit", () => {
  test("a green pull request run of an open fix/red-dev-<issue> to dev, at its head, is judged", () => {
    expect(admit(REPO, RUN, [PR])).toEqual({ kind: "judge", pr: 490, sha: SHA });
  });

  test("a run of another event, branch, repository or conclusion is left alone, and says why", () => {
    const cases: [Partial<Run>, string][] = [
      [{ event: "push" }, "the run's event is push, not pull_request"],
      [{ headBranch: "fix/red-dev-x" }, "the run's branch fix/red-dev-x is no fix/red-dev-<issue>"],
      [{ headBranch: "feature/red-dev-489" }, "is no fix/red-dev-<issue>"],
      [{ headBranch: "fix/red-dev-489/more" }, "is no fix/red-dev-<issue>"],
      [{ headRepository: "fork/r" }, "the run's head is in fork/r, not in o/r"],
      [{ conclusion: "failure" }, "ended failure, not success"],
      [{ conclusion: "cancelled" }, "ended cancelled, not success"],
    ];

    for (const [fields, reason] of cases) {
      const admission = admit(REPO, { ...RUN, ...fields }, [PR]);

      expect(admission.kind).toBe("none");
      expect(admission.kind === "none" && admission.reason).toContain(reason);
    }
  });

  test("a pull request missing, from a fork, moved on, to another base, or answered is left alone", () => {
    const cases: [readonly PullRequest[], string][] = [
      [[], "no open pull request comes from fix/red-dev-489 in o/r"],
      [[{ ...PR, crossRepository: true }], "no open pull request comes from"],
      [[{ ...PR, headSha: "ccc" }], `#490's head is ccc, no longer the run's ${SHA}`],
      [[{ ...PR, base: "main" }], "#490 targets main, not dev"],
      [[{ ...PR, texts: ["hi", markerOf(SHA)] }], `#490 is answered already at ${SHA}`],
    ];

    for (const [prs, reason] of cases) {
      const admission = admit(REPO, RUN, prs);

      expect(admission.kind).toBe("none");
      expect(admission.kind === "none" && admission.reason).toContain(reason);
    }
  });

  test("a fork's pull request of the same branch name gives way to this repository's", () => {
    expect(admit(REPO, RUN, [{ ...PR, number: 7, crossRepository: true }, PR])).toEqual({
      kind: "judge",
      pr: 490,
      sha: SHA,
    });
  });

  test("an answer to an earlier head does not hold back the new one", () => {
    expect(admit(REPO, RUN, [{ ...PR, texts: [markerOf("aaa")] }]).kind).toBe("judge");
  });
});

describe("tierOf", () => {
  test("reads tier.ts's line", () => {
    expect(tierOf("low a test fix\n")).toEqual({ tier: "low", reason: "a test fix" });
    expect(tierOf("human touches a risky path\n")).toEqual({
      tier: "human",
      reason: "touches a risky path",
    });
  });

  test("anything else reads human", () => {
    for (const output of ["", "medium why", "low", "LOW fine"]) {
      expect(tierOf(output).tier).toBe("human");
    }
  });
});

describe("decide", () => {
  const judged = { pr: 490, sha: SHA, tier: { tier: "low", reason: "a test fix" } } as const;

  test("low with dev its ancestor pushes, and says so on the pull request", () => {
    expect(decide({ ...judged, devIsAncestor: true })).toEqual({
      kind: "push",
      pr: 490,
      sha: SHA,
      comment: `red-dev-land pushed ${SHA} to \`dev\`, a fast-forward: its tier is \`low\`, a test fix\n\n${markerOf(SHA)}`,
    });
  });

  test("low with dev moved comments, and pushes nothing", () => {
    const action = decide({ ...judged, devIsAncestor: false });

    expect(action.kind).toBe("comment");
    expect(action.kind === "comment" && action.body).toContain("`dev` moved");
    expect(action.kind === "comment" && action.body).toEndWith(markerOf(SHA));
  });

  test("human comments with the reason and land.ts, whatever dev did", () => {
    for (const devIsAncestor of [true, false]) {
      const action = decide({
        ...judged,
        tier: { tier: "human", reason: "touches a risky path" },
        devIsAncestor,
      });

      expect(action).toEqual({
        kind: "comment",
        pr: 490,
        body: `red-dev-land leaves ${SHA} to a human: its tier is \`human\`, touches a risky path\n\nA human lands it with \`bun ./scripts/land.ts <branch>\`.\n\n${markerOf(SHA)}`,
      });
    }
  });
});

const ENV = {
  GITHUB_REPOSITORY: REPO,
  RUN_EVENT: RUN.event,
  RUN_CONCLUSION: RUN.conclusion,
  RUN_HEAD_BRANCH: RUN.headBranch,
  RUN_HEAD_SHA: RUN.headSha,
  RUN_HEAD_REPOSITORY: RUN.headRepository,
};

const ok = (code = 0): Promise<GitResult> => Promise.resolve({ code, stdout: "", stderr: "" });

/** GitHub and git as red-dev-land sees them: the open pull requests, dev's ancestry, the pushes. */
function world(fields: { prs?: PullRequest[]; tier?: string; ancestor?: number }) {
  const calls: string[] = [];
  const comments: string[] = [];
  const pushes: string[] = [];
  const prs = fields.prs ?? [PR];

  const gh: Gh = (args) => {
    calls.push(`gh ${args.join(" ")}`);
    const [command, sub] = args;

    if (command === "pr" && sub === "list") {
      return Promise.resolve(
        JSON.stringify(
          prs.map((pr) => ({
            number: pr.number,
            headRefOid: pr.headSha,
            baseRefName: pr.base,
            isCrossRepository: pr.crossRepository,
            comments: pr.texts.map((body) => ({ body })),
          })),
        ),
      );
    }

    if (command === "pr" && sub === "comment") {
      comments.push(args[args.indexOf("--body") + 1] ?? "");

      return Promise.resolve("");
    }

    return Promise.reject(new Error(`unexpected gh ${args.join(" ")}`));
  };

  const git: Git = (args) => {
    calls.push(`git ${args.join(" ")}`);
    const [command] = args;

    if (command === "fetch") return ok();

    if (command === "merge-base") return ok(fields.ancestor ?? 0);

    if (command === "push") {
      pushes.push(args.at(-1) ?? "");

      return ok();
    }

    return Promise.reject(new Error(`unexpected git ${args.join(" ")}`));
  };

  const tier = (pr: number, sha: string): Promise<string> => {
    calls.push(`tier ${pr} ${sha}`);

    return Promise.resolve(fields.tier ?? "low a test fix\n");
  };

  return { calls, comments, pushes, gh, git, tier };
}

describe("report", () => {
  test("a low head with dev its ancestor is pushed to dev, then the pull request says so", async () => {
    const { calls, comments, pushes, gh, git, tier } = world({});

    expect(await report(ENV, gh, git, tier)).toBe(`pushed ${SHA} to dev for #490`);
    expect(pushes).toEqual([`${SHA}:refs/heads/dev`]);
    expect(comments).toHaveLength(1);
    expect(calls).toContain(
      `git fetch --no-tags origin +refs/heads/dev:refs/remotes/origin/dev ${SHA}`,
    );
    expect(calls).toContain(`git merge-base --is-ancestor refs/remotes/origin/dev ${SHA}`);
    expect(calls.findIndex((call) => call.startsWith("git push"))).toBeLessThan(
      calls.findIndex((call) => call.startsWith("gh pr comment")),
    );
  });

  test("a human head, or dev moved, comments and pushes nothing", async () => {
    for (const fields of [{ tier: "human risky\n" }, { ancestor: 1 }]) {
      const { comments, pushes, gh, git, tier } = world(fields);

      expect(await report(ENV, gh, git, tier)).toBe("commented on #490");
      expect(pushes).toEqual([]);
      expect(comments).toHaveLength(1);
    }
  });

  test("a run it does not admit reads no pull request, runs no tier and touches no git", async () => {
    const { calls, gh, git, tier } = world({});

    expect(await report({ ...ENV, RUN_EVENT: "push" }, gh, git, tier)).toBe(
      "the run's event is push, not pull_request",
    );
    expect(calls).toEqual([]);

    expect(await report({ ...ENV, RUN_CONCLUSION: "failure" }, gh, git, tier)).toContain(
      "not success",
    );
    expect(calls.every((call) => call.startsWith("gh pr list"))).toBe(true);
  });

  test("a merge-base that fails stops the run, nothing pushed", async () => {
    const { pushes, comments, gh, git, tier } = world({ ancestor: 128 });

    await expect(report(ENV, gh, git, tier)).rejects.toThrow("git merge-base exited 128");
    expect(pushes).toEqual([]);
    expect(comments).toEqual([]);
  });

  test("refuses a run whose environment lacks a variable", async () => {
    const { gh, git, tier } = world({});

    await expect(report({ GITHUB_REPOSITORY: REPO }, gh, git, tier)).rejects.toThrow(
      "RUN_EVENT is unset",
    );
  });
});

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string | number>;
  env?: Record<string, string>;
}

interface Workflow {
  on?: unknown;
  concurrency?: unknown;
  permissions?: unknown;
  jobs: Record<string, { permissions?: unknown; steps: Step[] }>;
}

const workflowAt = async (path: string): Promise<Workflow> =>
  parse(await Bun.file(join(import.meta.dir, "..", "..", path)).text());

const pinOf = async (path: string, job: string): Promise<string | undefined> =>
  (await workflowAt(path)).jobs[job]?.steps.find((step) => step.name?.startsWith("Pin Claude Code"))
    ?.run;

describe("red-dev-land.yml", () => {
  test("wakes on each CI run completed on a fix/red-dev branch, one run at a time", async () => {
    const workflow = await workflowAt(".github/workflows/red-dev-land.yml");

    expect(workflow.on).toEqual({
      workflow_run: { workflows: ["CI"], types: ["completed"], branches: ["fix/red-dev-*"] },
    });
    expect(workflow.concurrency).toEqual({ group: "red-dev-land", "cancel-in-progress": false });
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs["red-dev-land"]?.permissions).toBeUndefined();
  });

  test("runs the default branch's code, with the App's token, and never the pull request's", async () => {
    const steps = (await workflowAt(".github/workflows/red-dev-land.yml")).jobs["red-dev-land"]
      ?.steps;

    const checkout = steps?.find((step) => step.uses?.startsWith("actions/checkout@"));

    expect(checkout?.with).toEqual({
      ref: "${{ github.event.repository.default_branch }}",
      "fetch-depth": 0,
      token: "${{ steps.app.outputs.token }}",
    });

    const land = steps?.find((step) => step.run === "bun ./scripts/ci/red-dev-land.ts");

    expect(land?.env?.["GH_TOKEN"]).toBe("${{ steps.app.outputs.token }}");
    expect(land?.env?.["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
  });

  test("pins Claude Code as ci.yml's validate does", async () => {
    const pin = await pinOf(".github/workflows/red-dev-land.yml", "red-dev-land");

    expect(pin).toBeString();
    expect(pin).toBe(await pinOf(".github/workflows/ci.yml", "validate"));
  });
});
